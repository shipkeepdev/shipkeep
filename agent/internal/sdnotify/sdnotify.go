// Package sdnotify tells systemd that the agent is ready (`Type=notify`, ADR 0028), with one
// datagram on the socket systemd names in NOTIFY_SOCKET. Outside systemd it does nothing.
package sdnotify

import (
	"fmt"
	"net"
	"os"
)

// Ready is the state systemd waits for before it considers the agent started.
const Ready = "READY=1"

// Notify sends state to systemd. It is a no-op when NOTIFY_SOCKET is unset.
func Notify(state string) error {
	return notify(os.Getenv("NOTIFY_SOCKET"), state)
}

func notify(socket, state string) error {
	if socket == "" {
		return nil
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
	if _, err := conn.Write([]byte(state)); err != nil {
		return fmt.Errorf("notify systemd: %w", err)
	}
	return nil
}
