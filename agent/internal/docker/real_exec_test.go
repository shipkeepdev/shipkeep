//go:build integration

package docker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// A small public image, pinned by digest, as in the actions' real Docker tests.
const realBusybox = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

func realClient(t *testing.T) *Client {
	t.Helper()
	socket := os.Getenv("SHIPKEEP_IT_DOCKER")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	client, err := New("unix://" + socket)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// realContainer runs busybox, idle, until the test ends.
func realContainer(t *testing.T, client *Client) string {
	t.Helper()
	ctx := context.Background()
	repository, digest, _ := strings.Cut(realBusybox, "@")
	if err := client.PullImage(ctx, repository, digest, nil); err != nil {
		t.Fatal(err)
	}
	id, err := client.CreateContainer(ctx, "", ContainerConfig{
		Image: realBusybox, Cmd: []string{"sleep", "300"}, Labels: map[string]string{"sk.test": "exec"},
		HostConfig: HostConfig{NetworkMode: "none", SecurityOpt: []string{"no-new-privileges"}, PidsLimit: 64},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.RemoveContainer(context.Background(), id, true) })
	if err := client.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRealExecCarriesStdinAndSeparatesStreams(t *testing.T) {
	client := realClient(t)
	container := realContainer(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	// The argument is one argv entry: the shell sees it as its script, and nothing splits it.
	created, err := client.CreateExec(ctx, container, ExecConfig{Argv: []string{"sh", "-c", "read line; echo \"out:$line\"; echo err >&2; exit 7"}})
	if err != nil {
		t.Fatal(err)
	}
	id := created.ID
	session, err := client.StartExec(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close() //nolint:errcheck // test session
	if _, err := session.Write([]byte("hello; id\n")); err != nil {
		t.Fatal(err)
	}
	if err := session.CloseStdin(); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	for {
		stream, data, err := session.Next(4096)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if stream == Stdout {
			stdout.Write(data)
		} else {
			stderr.Write(data)
		}
	}
	if stdout.String() != "out:hello; id\n" || stderr.String() != "err\n" {
		t.Fatalf("stdout %q, stderr %q", stdout.String(), stderr.String())
	}
	state, err := client.InspectExec(ctx, id)
	if err != nil || state.Running || state.ExitCode != 7 {
		t.Fatalf("state %+v, %v", state, err)
	}
}

func TestRealTTYExecResizes(t *testing.T) {
	client := realClient(t)
	container := realContainer(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	created, err := client.CreateExec(ctx, container, ExecConfig{Argv: []string{"sh"}, TTY: true})
	if err != nil {
		t.Fatal(err)
	}
	id := created.ID
	session, err := client.StartExec(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close() //nolint:errcheck // test session
	if err := client.ResizeExec(ctx, id, 123, 45); err != nil {
		t.Fatal(err)
	}
	if _, err := session.Write([]byte("stty size; exit\n")); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	for !strings.Contains(output.String(), "45 123") {
		_, data, err := session.Next(4096)
		if err != nil {
			t.Fatalf("output %q: %v", output.String(), err)
		}
		output.Write(data)
	}
}

func TestRealExecInAStoppedContainerIsRefused(t *testing.T) {
	client := realClient(t)
	container := realContainer(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := client.StopContainer(ctx, container, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateExec(ctx, container, ExecConfig{Argv: []string{"true"}}); err == nil {
		t.Fatal("an exec was created in a stopped container")
	}
}

// Ctrl-P then Ctrl-Q, Docker's default detach sequence, reach the command like any other keys.
func TestRealTTYExecKeepsTheDefaultDetachKeys(t *testing.T) {
	client := realClient(t)
	container := realContainer(t, client)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	created, err := client.CreateExec(ctx, container, ExecConfig{Argv: []string{"sh"}, TTY: true})
	if err != nil {
		t.Fatal(err)
	}
	session, err := client.StartExec(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close() //nolint:errcheck // test session
	if _, err := session.Write([]byte("\x10\x11\x15echo still-attached; exit\n")); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	for !strings.Contains(output.String(), "\nstill-attached") {
		_, data, err := session.Next(4096)
		if err != nil {
			t.Fatalf("output %q: %v", output.String(), err)
		}
		output.Write(data)
	}
}
