package sdnotify

import (
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
	if err := Notify(Ready); err != nil {
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
	if err := Notify(Ready); err != nil {
		t.Fatal(err)
	}
}

func TestNotifyReportsAMissingSocket(t *testing.T) {
	if err := notify(filepath.Join(t.TempDir(), "absent"), Ready); err == nil {
		t.Fatal("a missing socket reported as notified")
	}
}
