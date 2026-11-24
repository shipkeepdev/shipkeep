// Package sdnotify tells systemd that the agent is ready (`Type=notify`, ADR 0028), with one
// datagram on the socket systemd names in NOTIFY_SOCKET. Outside systemd it does nothing.
package sdnotify

import (
	"context"
	"fmt"
	"net"
	"os"
	"time"
)

// Ready is the state systemd waits for before it considers the agent started.
const Ready = "READY=1"

// writeWithin bounds the one write. systemd reads its socket at once: a queue that stays full is
// a receiver that is stuck, and the agent does not wait for it.
const writeWithin = 2 * time.Second

// Notify sends state to systemd. It is a no-op when NOTIFY_SOCKET is unset. It waits at most
// writeWithin, and no longer than ctx.
func Notify(ctx context.Context, state string) error {
	return notify(ctx, os.Getenv("NOTIFY_SOCKET"), state)
}

func notify(ctx context.Context, socket, state string) error {
	if socket == "" {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("notify systemd: %w", err)
	}
	// A leading @ names a socket in the abstract namespace.
	if socket[0] == '@' {
		socket = "\x00" + socket[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: socket, Net: "unixgram"})
	if err != nil {
		return fmt.Errorf("reach systemd: %w", err)
	}
	defer conn.Close() //nolint:errcheck // one datagram, already sent or failed
	deadline := time.Now().Add(writeWithin)
	if until, set := ctx.Deadline(); set && until.Before(deadline) {
		deadline = until
	}
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return fmt.Errorf("notify systemd: %w", err)
	}
	// Cancelling ctx moves the deadline to the past, which ends a write that is waiting.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetWriteDeadline(time.Unix(1, 0)) })
	defer stop()
	if _, err := conn.Write([]byte(state)); err != nil {
		return fmt.Errorf("notify systemd: %w", err)
	}
	return nil
}
