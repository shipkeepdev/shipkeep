package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const fakeExec = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func frame(stream byte, data string) []byte {
	out := make([]byte, 8, 8+len(data))
	out[0] = stream
	binary.BigEndian.PutUint32(out[4:], uint32(len(data))) //nolint:gosec // test data is small
	return append(out, data...)
}

func TestCreateExecSendsTheArgumentVector(t *testing.T) {
	var seen map[string]any
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.EscapedPath() != "/"+apiVersion+"/containers/sk-app%2F..%2Fx/exec" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&seen)
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": fakeExec})
	})
	// A reference with a slash stays one path segment.
	id, err := client.CreateExec(context.Background(), "sk-app/../x", ExecConfig{Argv: []string{"sh", "-c", "id; rm -rf /"}, TTY: true, User: "1000"})
	if err != nil || id != fakeExec {
		t.Fatalf("got %q, %v", id, err)
	}
	cmd, _ := seen["Cmd"].([]any)
	if len(cmd) != 3 || cmd[2] != "id; rm -rf /" || seen["Tty"] != true || seen["User"] != "1000" || seen["AttachStdin"] != true {
		t.Fatalf("request: %v", seen)
	}
	if _, err := client.CreateExec(context.Background(), "c", ExecConfig{}); err == nil {
		t.Fatal("an empty argument vector was sent")
	}
}

func TestCreateExecRefusesAnInvalidID(t *testing.T) {
	for _, id := range []string{"", "../../containers/x", strings.Repeat("A", 64), fakeExec + "0"} {
		client := fakeDaemon(t, func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"Id": id})
		})
		if _, err := client.CreateExec(context.Background(), "c", ExecConfig{Argv: []string{"true"}}); err == nil {
			t.Fatalf("accepted the exec id %q", id)
		}
	}
}

// startDaemon answers the exec start by taking over the connection, as Docker does, then runs
// session with it.
func startDaemon(t *testing.T, session func(*bufio.ReadWriter)) *Client {
	t.Helper()
	return fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+apiVersion+"/exec/"+fakeExec+"/start" || r.Header.Get("Upgrade") != "tcp" {
			http.NotFound(w, r)
			return
		}
		var body struct{ Detach, Tty bool }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Detach {
			http.Error(w, "detached", http.StatusBadRequest)
			return
		}
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close() //nolint:errcheck // test connection
		_, _ = rw.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = rw.Flush()
		session(rw)
	})
}

func TestExecSeparatesStdoutFromStderrAndCarriesStdin(t *testing.T) {
	client := startDaemon(t, func(rw *bufio.ReadWriter) {
		line, _ := rw.ReadString('\n')
		_, _ = rw.Write(frame(Stdout, "you said "+line))
		_, _ = rw.Write(frame(Stderr, "warning"))
		_ = rw.Flush()
		// Stdin closed: the command ends.
		_, _ = io.Copy(io.Discard, rw)
		_, _ = rw.Write(frame(Stdout, "bye"))
		_ = rw.Flush()
	})
	exec, err := client.StartExec(context.Background(), fakeExec, false)
	if err != nil {
		t.Fatal(err)
	}
	defer exec.Close() //nolint:errcheck // test session
	if _, err := exec.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		stream int
		data   string
	}{{Stdout, "you said hello\n"}, {Stderr, "warning"}} {
		stream, data, err := exec.Next(64)
		if err != nil || stream != want.stream || string(data) != want.data {
			t.Fatalf("got %d %q %v, want %d %q", stream, data, err, want.stream, want.data)
		}
	}
	if err := exec.CloseStdin(); err != nil {
		t.Fatal(err)
	}
	if stream, data, err := exec.Next(64); err != nil || stream != Stdout || string(data) != "bye" {
		t.Fatalf("after stdin closed: %d %q %v", stream, data, err)
	}
	if _, _, err := exec.Next(64); !errors.Is(err, io.EOF) {
		t.Fatalf("end of output: %v", err)
	}
}

func TestATTYExecIsOneRawStream(t *testing.T) {
	client := startDaemon(t, func(rw *bufio.ReadWriter) {
		// Raw bytes that would be a frame header without a tty.
		_, _ = rw.Write([]byte{2, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, '$', ' '})
		_ = rw.Flush()
	})
	exec, err := client.StartExec(context.Background(), fakeExec, true)
	if err != nil {
		t.Fatal(err)
	}
	defer exec.Close() //nolint:errcheck // test session
	var got []byte
	for len(got) < 10 {
		stream, data, err := exec.Next(4)
		if err != nil || stream != Stdout || len(data) > 4 {
			t.Fatalf("got %d %q %v", stream, data, err)
		}
		got = append(got, data...)
	}
	if !bytes.Equal(got, []byte{2, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, '$', ' '}) {
		t.Fatalf("got %q", got)
	}
}

func TestStartExecReportsTheStatusOnly(t *testing.T) {
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/start") && strings.Contains(r.URL.Path, "/exec/"+fakeExec) {
			http.Error(w, "container /var/lib/secret-path is not running", http.StatusConflict)
			return
		}
		http.NotFound(w, r)
	})
	_, err := client.StartExec(context.Background(), fakeExec, false)
	if err == nil || strings.Contains(err.Error(), "secret-path") || !strings.Contains(err.Error(), "409") {
		t.Fatalf("got %v", err)
	}
	for _, id := range []string{"", "../x", fakeExec + "/../../containers"} {
		if _, err := client.StartExec(context.Background(), id, false); err == nil {
			t.Fatalf("started the exec id %q", id)
		}
	}
}

func TestStartExecStopsWithItsContext(t *testing.T) {
	client := fakeDaemon(t, func(_ http.ResponseWriter, r *http.Request) {
		// Never answers.
		<-r.Context().Done()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := client.StartExec(ctx, fakeExec, false); err == nil {
		t.Fatal("a start that never answered succeeded")
	}
}

func TestReadFrameRefusesMalformedOutput(t *testing.T) {
	for name, data := range map[string][]byte{
		"stdin stream":        append([]byte{0, 0, 0, 0, 0, 0, 0, 1}, 'x'),
		"unknown stream":      append([]byte{3, 0, 0, 0, 0, 0, 0, 1}, 'x'),
		"padding":             append([]byte{1, 0, 1, 0, 0, 0, 0, 1}, 'x'),
		"oversized":           {1, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff},
		"truncated header":    {1, 0, 0},
		"truncated body":      {1, 0, 0, 0, 0, 0, 0, 9, 'a'},
		"just over the limit": {1, 0, 0, 0, 0, 0x10, 0, 1},
	} {
		if _, _, err := readFrame(bytes.NewReader(data)); err == nil || errors.Is(err, io.EOF) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, _, err := readFrame(bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Fatalf("an empty stream is the end: %v", err)
	}
	stream, data, err := readFrame(bytes.NewReader(frame(Stderr, "")))
	if err != nil || stream != Stderr || len(data) != 0 {
		t.Fatalf("an empty frame: %d %q %v", stream, data, err)
	}
}

func TestResizeAndInspectExec(t *testing.T) {
	var resized string
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/" + apiVersion + "/exec/" + fakeExec + "/resize":
			resized = r.URL.RawQuery
		case "/" + apiVersion + "/exec/" + fakeExec + "/json":
			_, _ = w.Write([]byte(`{"Running":false,"ExitCode":3,"Pid":0}`))
		default:
			http.NotFound(w, r)
		}
	})
	if err := client.ResizeExec(context.Background(), fakeExec, 120, 40); err != nil || resized != "h=40&w=120" {
		t.Fatalf("resize: %q %v", resized, err)
	}
	state, err := client.InspectExec(context.Background(), fakeExec)
	if err != nil || state.Running || state.ExitCode != 3 {
		t.Fatalf("inspect: %+v %v", state, err)
	}
	if err := client.ResizeExec(context.Background(), "../x", 1, 1); err == nil {
		t.Fatal("resized an invalid exec id")
	}
	if _, err := client.InspectExec(context.Background(), "x"); err == nil {
		t.Fatal("inspected an invalid exec id")
	}
}
