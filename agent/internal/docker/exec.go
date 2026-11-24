package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
)

// ExecConfig is one command run inside a container (SPEC 3.3, ExecSession). Argv is an argument
// vector, never a shell string: the daemon runs Argv[0] with the rest as its arguments.
type ExecConfig struct {
	Argv []string
	TTY  bool
	// User inside the container; empty means the container's default.
	User string
}

// Output streams of an exec, as Docker numbers them in its multiplexed frames.
const (
	Stdout = 1
	Stderr = 2
)

// maxFrame bounds one frame of multiplexed output: Docker writes at most 32 KiB at a time, and
// a larger header can only be a corrupt or hostile stream.
const maxFrame = 1 << 20

var execID = regexp.MustCompile(`^[a-f0-9]{64}$`)

// CreateExec creates an exec instance in the container ref, attached to stdin, stdout and stderr,
// and returns its id. Docker refuses it for a container that is not running.
func (c *Client) CreateExec(ctx context.Context, ref string, config ExecConfig) (string, error) {
	if len(config.Argv) == 0 {
		return "", errors.New("docker exec needs an argument vector")
	}
	body := struct {
		AttachStdin  bool
		AttachStdout bool
		AttachStderr bool
		Tty          bool
		Cmd          []string
		User         string `json:",omitempty"`
	}{true, true, true, config.TTY, config.Argv, config.User}
	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(ref)+"/exec", body, &created); err != nil {
		return "", err
	}
	if !execID.MatchString(created.ID) {
		return "", errors.New("docker returned an invalid exec id")
	}
	return created.ID, nil
}

// Exec is a started exec: the connection Docker hands over once it runs the command. Writes go
// to the command's stdin; Next reads its output.
type Exec struct {
	conn   net.Conn
	reader *bufio.Reader
	tty    bool
	close  sync.Once
}

// StartExec starts the exec id and takes over its connection. With tty, the output is one raw
// stream (Docker merges stderr into it); without, it is multiplexed and Next tells them apart.
// The context bounds the start only: the session then lasts until Close.
func (c *Client) StartExec(ctx context.Context, id string, tty bool) (*Exec, error) {
	if !execID.MatchString(id) {
		return nil, errors.New("invalid docker exec id")
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, fmt.Errorf("docker exec start: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close() //nolint:errcheck,gosec // the start already failed
		}
	}()
	// The start is written and read on this connection by hand: net/http would not give it back.
	stop := context.AfterFunc(ctx, func() { conn.Close() }) //nolint:errcheck,gosec // unblocks the reads below
	data, err := json.Marshal(struct {
		Detach bool
		Tty    bool
	}{false, tty})
	if err != nil {
		return nil, fmt.Errorf("encode docker exec start: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker/"+apiVersion+"/exec/"+id+"/start", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("build docker exec start: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "tcp")
	if err := request.Write(conn); err != nil {
		return nil, fmt.Errorf("docker exec start: %w", err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return nil, fmt.Errorf("docker exec start: %w", err)
	}
	if !stop() {
		return nil, fmt.Errorf("docker exec start: %w", ctx.Err())
	}
	switch response.StatusCode {
	case http.StatusSwitchingProtocols, http.StatusOK:
	case http.StatusNotFound:
		response.Body.Close() //nolint:errcheck,gosec // read-only body
		return nil, ErrNotFound
	default:
		response.Body.Close() //nolint:errcheck,gosec // read-only body
		// The daemon's message can name paths: report the status only.
		return nil, fmt.Errorf("docker exec start: status %d", response.StatusCode)
	}
	ok = true
	return &Exec{conn: conn, reader: reader, tty: tty}, nil
}

// Write sends p to the command's stdin.
func (e *Exec) Write(p []byte) (int, error) {
	n, err := e.conn.Write(p)
	if err != nil {
		return n, fmt.Errorf("docker exec stdin: %w", err)
	}
	return n, nil
}

// CloseStdin ends the command's stdin and keeps its output open.
func (e *Exec) CloseStdin() error {
	closer, ok := e.conn.(interface{ CloseWrite() error })
	if !ok {
		return errors.New("docker exec connection cannot close stdin alone")
	}
	return closer.CloseWrite()
}

// Next returns the next piece of output and its stream, Stdout or Stderr, at most max bytes for
// a tty session. It returns io.EOF once the command's output ended.
func (e *Exec) Next(max int) (int, []byte, error) {
	if e.tty {
		buffer := make([]byte, max)
		n, err := e.reader.Read(buffer)
		if n > 0 {
			return Stdout, buffer[:n], nil
		}
		return 0, nil, fmt.Errorf("docker exec output: %w", err)
	}
	return readFrame(e.reader)
}

// Close ends the session's connection. Docker then closes the command's stdin; the command
// itself may still run, and the caller stops it if it must.
func (e *Exec) Close() error {
	var err error
	e.close.Do(func() {
		if closeErr := e.conn.Close(); closeErr != nil {
			err = fmt.Errorf("close docker exec: %w", closeErr)
		}
	})
	return err
}

// readFrame reads one frame of Docker's multiplexed stream: a header of the stream (1 byte),
// three zero bytes and the length (4 bytes, big endian), then that many bytes.
func readFrame(reader io.Reader) (int, []byte, error) {
	var header [8]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return 0, nil, errors.New("docker exec output ended inside a frame header")
		}
		return 0, nil, fmt.Errorf("docker exec output: %w", err)
	}
	stream := int(header[0])
	if (stream != Stdout && stream != Stderr) || header[1] != 0 || header[2] != 0 || header[3] != 0 {
		return 0, nil, errors.New("docker exec output has an invalid frame header")
	}
	size := binary.BigEndian.Uint32(header[4:])
	if size > maxFrame {
		return 0, nil, errors.New("docker exec output frame too large")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		return 0, nil, errors.New("docker exec output ended inside a frame")
	}
	return stream, data, nil
}

// ResizeExec sets the terminal size of a tty exec.
func (c *Client) ResizeExec(ctx context.Context, id string, cols, rows uint32) error {
	if !execID.MatchString(id) {
		return errors.New("invalid docker exec id")
	}
	query := url.Values{"w": {strconv.FormatUint(uint64(cols), 10)}, "h": {strconv.FormatUint(uint64(rows), 10)}}
	return c.do(ctx, http.MethodPost, "/exec/"+id+"/resize?"+query.Encode(), nil, nil)
}

// ExecState is what Docker reports of an exec: whether its command still runs, its exit code
// once it ended, and the host process id while it runs (0 otherwise).
type ExecState struct {
	Running  bool `json:"Running"`
	ExitCode int  `json:"ExitCode"`
	Pid      int  `json:"Pid"`
}

// InspectExec reads the state of the exec id.
func (c *Client) InspectExec(ctx context.Context, id string) (ExecState, error) {
	if !execID.MatchString(id) {
		return ExecState{}, errors.New("invalid docker exec id")
	}
	var state ExecState
	if err := c.do(ctx, http.MethodGet, "/exec/"+id+"/json", nil, &state); err != nil {
		return ExecState{}, err
	}
	return state, nil
}
