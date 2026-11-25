package docker

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// logsDaemon answers a logs request with frames, as Docker does with timestamps.
func logsDaemon(t *testing.T, contentType string, frames ...[]byte) (*Client, *string) {
	t.Helper()
	var query string
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+apiVersion+"/containers/sk-app-r1-0/logs" {
			http.NotFound(w, r)
			return
		}
		query = r.URL.RawQuery
		w.Header().Set("Content-Type", contentType)
		for _, data := range frames {
			_, _ = w.Write(data)
		}
	})
	return client, &query
}

const multiplexed = "application/vnd.docker.multiplexed-stream"

func stamped(stream byte, at, text string) []byte {
	return frame(stream, at+" "+text)
}

func follow(t *testing.T, client *Client) ([]LogLine, error) {
	t.Helper()
	var lines []LogLine
	err := client.FollowLogs(context.Background(), "sk-app-r1-0", time.Unix(1700000000, 5), func(line LogLine) error {
		lines = append(lines, line)
		return nil
	})
	return lines, err
}

func TestFollowLogsReadsLinesWithTheirStreamAndTime(t *testing.T) {
	client, query := logsDaemon(t, multiplexed,
		stamped(Stdout, "2026-11-24T20:00:00.000000001Z", "hello\n"),
		stamped(Stderr, "2026-11-24T20:00:01Z", "warn\r\n"),
		// Docker split a long line: the second part has its own timestamp and ends it.
		stamped(Stdout, "2026-11-24T20:00:02Z", "first half, "),
		stamped(Stderr, "2026-11-24T20:00:02.5Z", "interleaved\n"),
		stamped(Stdout, "2026-11-24T20:00:03Z", "second half\n"),
		// Two lines in one message, and a last one without a newline.
		stamped(Stdout, "2026-11-24T20:00:04Z", "a\nb\nno newline"),
	)
	lines, err := follow(t, client)
	if err != nil {
		t.Fatal(err)
	}
	at := func(sec, nsec int) time.Time { return time.Date(2026, 11, 24, 20, 0, sec, nsec, time.UTC) }
	want := []LogLine{
		{Stream: Stdout, Time: at(0, 1), Resume: at(0, 1), Text: "hello"},
		{Stream: Stderr, Time: at(1, 0), Resume: at(1, 0), Text: "warn"},
		// Reading again from 20:00:02.5 would lose the first half of the stdout line still open.
		{Stream: Stderr, Time: at(2, 5e8), Resume: at(2, 0), Text: "interleaved"},
		{Stream: Stdout, Time: at(2, 0), Resume: at(2, 0), Text: "first half, second half"},
		{Stream: Stdout, Time: at(4, 0), Resume: at(4, 0), Text: "a"},
		{Stream: Stdout, Time: at(4, 0), Resume: at(4, 0), Text: "b"},
		{Stream: Stdout, Time: at(4, 0), Resume: at(4, 0), Text: "no newline"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %+v", lines)
	}
	for i := range want {
		got := lines[i]
		if got.Stream != want[i].Stream || !got.Time.Equal(want[i].Time) || !got.Resume.Equal(want[i].Resume) || got.Text != want[i].Text || got.Truncated {
			t.Errorf("line %d: got %+v, want %+v", i, got, want[i])
		}
	}
	for _, part := range []string{"follow=1", "timestamps=1", "stdout=1", "stderr=1", "since=1700000000.000000005"} {
		if !strings.Contains(*query, part) {
			t.Errorf("query %q lacks %s", *query, part)
		}
	}
}

func TestFollowLogsBoundsAndCleansLines(t *testing.T) {
	long := strings.Repeat("x", MaxLogLine+100)
	// Each invalid byte becomes a three-byte replacement, so a line of alternating invalid and
	// valid bytes doubles: it is cut again, on a rune.
	invalid := strings.Repeat("\xffa", MaxLogLine/2)
	// A cut that would fall inside a character keeps the line before it.
	emoji := strings.Repeat("x", MaxLogLine-3) + "\U0001F680"
	client, _ := logsDaemon(t, multiplexed,
		stamped(Stdout, "2026-11-24T20:00:00Z", long[:MaxLogLine/2]),
		stamped(Stdout, "2026-11-24T20:00:01Z", long[MaxLogLine/2:]+"\n"),
		stamped(Stdout, "2026-11-24T20:00:02Z", invalid+"\n"),
		stamped(Stdout, "2026-11-24T20:00:03Z", "caf\xe9 \xff\xfe\n"),
		stamped(Stdout, "2026-11-24T20:00:04Z", emoji+"\n"),
	)
	lines, err := follow(t, client)
	if err != nil || len(lines) != 4 {
		t.Fatalf("got %d lines, %v", len(lines), err)
	}
	if len(lines[0].Text) != MaxLogLine || !lines[0].Truncated {
		t.Fatalf("long line: %d bytes, truncated %v", len(lines[0].Text), lines[0].Truncated)
	}
	if len(lines[1].Text) > MaxLogLine || !utf8.ValidString(lines[1].Text) || !lines[1].Truncated {
		t.Fatalf("invalid line: %d bytes, valid %v", len(lines[1].Text), utf8.ValidString(lines[1].Text))
	}
	if lines[2].Text != "caf� ��" || lines[2].Truncated {
		t.Fatalf("got %q", lines[2].Text)
	}
	if lines[3].Text != emoji[:MaxLogLine-3] || !lines[3].Truncated {
		t.Fatalf("emoji line ends with %q", lines[3].Text[len(lines[3].Text)-4:])
	}
}

func TestFollowLogsSendsARunawayLineOnceItIsFull(t *testing.T) {
	full := strings.Repeat("x", MaxLogLine)
	client, _ := logsDaemon(t, multiplexed,
		// A progress bar that never writes a newline: Docker splits it at its buffer size.
		stamped(Stdout, "2026-11-24T20:00:00Z", full),
		stamped(Stdout, "2026-11-24T20:00:01Z", "\rmore"),
		stamped(Stderr, "2026-11-24T20:00:02Z", "err\n"),
		stamped(Stdout, "2026-11-24T20:00:03Z", "\rstill more\nnext\n"),
	)
	lines, err := follow(t, client)
	if err != nil || len(lines) != 3 {
		t.Fatalf("got %+v, %v", lines, err)
	}
	first := lines[0]
	if first.Stream != Stdout || first.Text != full || !first.Truncated || first.Time.Second() != 0 {
		t.Fatalf("the full line did not come first: %d bytes, truncated %v, at %v", len(first.Text), first.Truncated, first.Time)
	}
	// The rest of the runaway line is dropped and holds no cursor back.
	if lines[1].Text != "err" || lines[1].Resume.Second() != 2 {
		t.Fatalf("got %+v", lines[1])
	}
	if lines[2].Text != "next" || lines[2].Truncated {
		t.Fatalf("got %+v", lines[2])
	}
}

func TestFollowLogsDropsWhatIsNotALogFrame(t *testing.T) {
	client, _ := logsDaemon(t, multiplexed,
		frame(Stdout, "no timestamp here\n"),
		frame(Stdout, "2026-13-45T99:00:00Z bad date\n"),
		stamped(Stdout, "2026-11-24T20:00:00Z", "kept\n"),
	)
	lines, err := follow(t, client)
	if err != nil || len(lines) != 1 || lines[0].Text != "kept" {
		t.Fatalf("got %+v, %v", lines, err)
	}
}

func TestFollowLogsRefusesAContainerWithATerminal(t *testing.T) {
	client, _ := logsDaemon(t, "application/vnd.docker.raw-stream", []byte("2026-11-24T20:00:00Z raw\n"))
	if _, err := follow(t, client); !errors.Is(err, errRawLogs) {
		t.Fatalf("got %v", err)
	}
}

func TestFollowLogsStopsOnAMalformedStreamOrAFailedEmit(t *testing.T) {
	client, _ := logsDaemon(t, multiplexed, []byte{1, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff})
	if _, err := follow(t, client); err == nil {
		t.Fatal("an oversized frame was accepted")
	}
	client, _ = logsDaemon(t, multiplexed,
		stamped(Stdout, "2026-11-24T20:00:00Z", "one\n"),
		stamped(Stdout, "2026-11-24T20:00:01Z", "two\n"),
	)
	stop := errors.New("stop")
	count := 0
	err := client.FollowLogs(context.Background(), "sk-app-r1-0", time.Time{}, func(LogLine) error {
		count++
		return stop
	})
	if !errors.Is(err, stop) || count != 1 {
		t.Fatalf("got %v after %d lines", err, count)
	}
}

func TestFollowLogsReportsStatusesOnly(t *testing.T) {
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "missing") {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "/var/lib/docker/secret", http.StatusInternalServerError)
	})
	noop := func(LogLine) error { return nil }
	if err := client.FollowLogs(context.Background(), "missing", time.Time{}, noop); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	err := client.FollowLogs(context.Background(), "sk-app", time.Time{}, noop)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("got %v", err)
	}
}

func TestFollowLogsTreatsAFrameCutAfterItsHeaderAsAnError(t *testing.T) {
	// A header that promises five bytes, then the end of the stream.
	client, _ := logsDaemon(t, multiplexed, []byte{1, 0, 0, 0, 0, 0, 0, 5})
	if _, err := follow(t, client); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("a cut frame ended the stream as %v", err)
	}
}

func TestFollowLogsSendsAFullLineBeforeItsNextFrame(t *testing.T) {
	full := strings.Repeat("x", MaxLogLine)
	client, _ := logsDaemon(t, multiplexed,
		// Exactly full, with its newline in the same frame: a whole line, not truncated.
		stamped(Stdout, "2026-11-24T20:00:00Z", full+"\n"),
		// Exactly full, no newline: sent before anything else arrives.
		stamped(Stdout, "2026-11-24T20:00:01Z", full),
		stamped(Stderr, "2026-11-24T20:00:02Z", "err\n"),
		stamped(Stdout, "2026-11-24T20:00:03Z", "\nnext\n"),
	)
	lines, err := follow(t, client)
	if err != nil || len(lines) != 4 {
		t.Fatalf("got %d lines, %v", len(lines), err)
	}
	if lines[0].Text != full || lines[0].Truncated {
		t.Fatalf("whole line: %d bytes, truncated %v", len(lines[0].Text), lines[0].Truncated)
	}
	if lines[1].Stream != Stdout || lines[1].Text != full || !lines[1].Truncated {
		t.Fatalf("the full line did not come before the stderr one: %+v", lines[1].Stream)
	}
	if lines[2].Text != "err" || lines[3].Text != "next" {
		t.Fatalf("got %q then %q", lines[2].Text, lines[3].Text)
	}
}

func TestFollowLogsCutsOnACharacterThatBeganInAnEarlierFrame(t *testing.T) {
	start := strings.Repeat("x", MaxLogLine-3)
	client, _ := logsDaemon(t, multiplexed,
		// A rocket split across Docker's frames: its first byte ends the first one.
		stamped(Stdout, "2026-11-24T20:00:00Z", start+"\xf0"),
		stamped(Stdout, "2026-11-24T20:00:01Z", "\x9f\x9a\x80tail\n"),
	)
	lines, err := follow(t, client)
	if err != nil || len(lines) != 1 {
		t.Fatalf("got %d lines, %v", len(lines), err)
	}
	if lines[0].Text != start || !lines[0].Truncated {
		t.Fatalf("line ends with %q, truncated %v", lines[0].Text[len(lines[0].Text)-4:], lines[0].Truncated)
	}
}
