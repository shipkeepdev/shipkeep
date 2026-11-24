package sdnotify

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestNotifySendsOneDatagramToTheSocketSystemdNames(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notify")
	listener, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close() //nolint:errcheck // test socket
	t.Setenv("NOTIFY_SOCKET", path)
	if err := Notify(context.Background(), Ready); err != nil {
		t.Fatal(err)
	}
	if err := listener.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 64)
	n, err := listener.Read(buffer)
	if err != nil || string(buffer[:n]) != "READY=1" {
		t.Fatalf("%q %v", buffer[:n], err)
	}
}

func TestNotifyDoesNothingOutsideSystemd(t *testing.T) {
	t.Setenv("NOTIFY_SOCKET", "")
	if err := Notify(context.Background(), Ready); err != nil {
		t.Fatal(err)
	}
}

func TestNotifyReportsAMissingSocket(t *testing.T) {
	if err := notify(context.Background(), filepath.Join(t.TempDir(), "absent"), Ready); err == nil {
		t.Fatal("a missing socket reported as notified")
	}
}

// A receiver whose queue stays full never makes the agent wait more than writeWithin, nor at all
// once its context ends.
func TestNotifyGivesUpOnAReceiverThatDoesNotRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notify")
	listener, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close() //nolint:errcheck // test socket
	// Fill the receiver's queue: a datagram socket that nobody reads.
	blocked := false
	for range 100_000 {
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		err := notify(ctx, path, Ready)
		cancel()
		if err != nil {
			if waited := time.Since(start); waited > time.Second {
				t.Fatalf("waited %v for a full queue", waited)
			}
			var timeout interface{ Timeout() bool }
			if !errors.As(err, &timeout) || !timeout.Timeout() {
				t.Fatalf("a full queue ended with %v", err)
			}
			blocked = true
			break
		}
	}
	if !blocked {
		t.Skip("the receiver's queue never filled")
	}
	// Cancelling the context ends the wait, well before writeWithin.
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	start := time.Now()
	if err := notify(ctx, path, Ready); err == nil {
		t.Fatal("a full queue reported as notified")
	}
	if waited := time.Since(start); waited >= writeWithin {
		t.Fatalf("cancelling did not end the wait: %v", waited)
	}
	// Without a deadline of its own, the wait still ends after writeWithin.
	start = time.Now()
	if err := notify(context.Background(), path, Ready); err == nil {
		t.Fatal("a full queue reported as notified")
	}
	if waited := time.Since(start); waited < writeWithin/2 || waited > writeWithin+time.Second {
		t.Fatalf("waited %v, not about %v", waited, writeWithin)
	}
	// An ended context sends nothing.
	if err := notify(ctx, path, Ready); !errors.Is(err, context.Canceled) {
		t.Fatalf("an ended context: %v", err)
	}
}
