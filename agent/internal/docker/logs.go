package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxLogLine bounds one line of a container's output (ADR 0029); a longer one is cut.
const MaxLogLine = 16 << 10

// LogLine is one line of a container's output.
type LogLine struct {
	// Stream is Stdout or Stderr.
	Stream int
	// Time is Docker's timestamp of the line, or of its first part.
	Time time.Time
	// Resume is where to read again from once this line is kept: its own time, or an earlier
	// one when a line of the other stream, still being joined, started before it. Reading
	// from Time instead could lose that line's first part.
	Resume time.Time
	// Text is the line without its newline: at most MaxLogLine bytes, valid UTF-8.
	Text string
	// Truncated says the line was longer and was cut.
	Truncated bool
}

// errRawLogs refuses the output of a container with a terminal, which Docker does not tell apart
// by stream: the agent never creates one.
var errRawLogs = errors.New("docker logs: container output is not multiplexed")

// FollowLogs reads the output of the container ref from since on, and calls emit with every
// line, in order, until ctx ends, emit fails, or the output ends (nil): the container stopped,
// or the daemon closed the stream, as when it restarts with live-restore, so the caller follows
// again a container still running. Lines Docker split, longer than its own buffer, are joined
// again up to MaxLogLine; a longer one is sent as soon as it is full, and the rest of it dropped.
func (c *Client) FollowLogs(ctx context.Context, ref string, since time.Time, emit func(LogLine) error) error {
	query := url.Values{
		"follow": {"1"}, "stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"},
		"since": {fmt.Sprintf("%d.%09d", since.Unix(), since.Nanosecond())},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/"+apiVersion+"/containers/"+url.PathEscape(ref)+"/logs?"+query.Encode(), nil)
	if err != nil {
		return fmt.Errorf("build docker logs request: %w", err)
	}
	response, err := c.long.Do(request)
	if err != nil {
		return fmt.Errorf("docker logs: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	switch {
	case response.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case response.StatusCode != http.StatusOK:
		// The daemon's message can contain paths: report the status only.
		return fmt.Errorf("docker logs: status %d", response.StatusCode)
	case response.Header.Get("Content-Type") == "application/vnd.docker.raw-stream":
		return errRawLogs
	}
	lines := lineReader{emit: emit}
	for {
		stream, data, err := readFrame(response.Body)
		if errors.Is(err, io.EOF) {
			return lines.flush()
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err() //nolint:wrapcheck // the caller's own cancellation
			}
			return fmt.Errorf("docker logs: %w", err)
		}
		if err := lines.frame(stream, data); err != nil {
			return err
		}
	}
}

// lineReader turns Docker's frames, each a timestamp, a space and a message, into lines. A
// message without a final newline is the first part of a longer line, continued by the next
// message of its stream.
type lineReader struct {
	emit    func(LogLine) error
	pending [Stderr + 1]*LogLine
	size    [Stderr + 1]int
	// dropping says the stream's current line was sent once full: its rest, up to its
	// newline, is dropped.
	dropping [Stderr + 1]bool
}

func (r *lineReader) frame(stream int, data []byte) error {
	at, message, ok := stampedMessage(data)
	if !ok {
		// Not what Docker writes with timestamps: the frame is dropped, never shown as a line.
		return nil
	}
	for {
		part, rest, complete := strings.Cut(message, "\n")
		if err := r.add(stream, at, part); err != nil {
			return err
		}
		if !complete {
			return nil
		}
		if err := r.end(stream); err != nil {
			return err
		}
		if rest == "" {
			return nil
		}
		message = rest
	}
}

// stampedMessage splits a frame into Docker's timestamp and the message after it.
func stampedMessage(data []byte) (time.Time, string, bool) {
	stamp, message, ok := strings.Cut(string(data), " ")
	at, err := time.Parse(time.RFC3339Nano, stamp)
	return at, message, ok && err == nil
}

// add appends a part to the stream's open line. A part that does not fit is cut on a
// character, and the line is sent at once, marked truncated.
func (r *lineReader) add(stream int, at time.Time, part string) error {
	if r.dropping[stream] {
		return nil
	}
	line := r.pending[stream]
	if line == nil {
		line = &LogLine{Stream: stream, Time: at}
		r.pending[stream] = line
		r.size[stream] = 0
	}
	room := MaxLogLine - r.size[stream]
	if len(part) <= room {
		line.Text += part
		r.size[stream] += len(part)
		return nil
	}
	cut := room
	for cut > 0 && !utf8.RuneStart(part[cut]) {
		cut--
	}
	line.Text += part[:cut]
	line.Truncated = true
	r.dropping[stream] = true
	return r.send(stream)
}

// end closes the stream's line at its newline.
func (r *lineReader) end(stream int) error {
	if r.dropping[stream] {
		r.dropping[stream] = false
		return nil
	}
	return r.send(stream)
}

// send emits the stream's open line, cleaned: without a final carriage return, in valid UTF-8
// and within MaxLogLine.
func (r *lineReader) send(stream int) error {
	line := r.pending[stream]
	r.pending[stream] = nil
	if line == nil {
		return nil
	}
	text := validText(strings.TrimSuffix(line.Text, "\r"))
	// A replacement takes three bytes where an invalid one took one: cut again, on a rune.
	if len(text) > MaxLogLine {
		cut := MaxLogLine
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text, line.Truncated = text[:cut], true
	}
	line.Text = text
	line.Resume = line.Time
	// A line of the other stream still open started earlier: reading again from this line's
	// time would lose that line's first part. One being dropped holds nothing back, since its
	// start was sent already.
	other := Stdout
	if stream == Stdout {
		other = Stderr
	}
	if open := r.pending[other]; open != nil && open.Time.Before(line.Resume) {
		line.Resume = open.Time
	}
	return r.emit(*line)
}

// validText replaces each byte that is not part of valid UTF-8 with U+FFFD (ADR 0029).
func validText(text string) string {
	if utf8.ValidString(text) {
		return text
	}
	var out strings.Builder
	out.Grow(len(text) + 16)
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == utf8.RuneError && size == 1 {
			out.WriteRune(utf8.RuneError)
		} else {
			out.WriteString(text[i : i+size])
		}
		i += size
	}
	return out.String()
}

// flush emits the last part of a line the container wrote without a newline before it stopped.
func (r *lineReader) flush() error {
	for _, stream := range []int{Stdout, Stderr} {
		if err := r.send(stream); err != nil {
			return err
		}
	}
	return nil
}
