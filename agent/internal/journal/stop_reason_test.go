package journal

import (
	"testing"
	"time"
)

func TestStopReasonsLastUntilTheContainerIsForgotten(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	now := time.Now()
	if err := store.RecordStopReason(t.Context(), "sk-full-0", "disk_limit", now); err != nil {
		t.Fatal(err)
	}
	reasons, err := store.StopReasons(t.Context())
	if err != nil || reasons["sk-full-0"] != "disk_limit" || len(reasons) != 1 {
		t.Fatalf("reasons %v %v", reasons, err)
	}
	if err := store.ClearIntent(t.Context(), "sk-full-0"); err != nil {
		t.Fatal(err)
	}
	if reasons, err := store.StopReasons(t.Context()); err != nil || len(reasons) != 0 {
		t.Fatalf("a removed container kept its reason: %v %v", reasons, err)
	}
}

func TestStopReasonsRefuseWhatTheAgentDoesNotWrite(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	for _, test := range []struct{ container, reason string }{
		{"sk-full-0", "oom"},
		{"sk-full-0", ""},
		{"sk-full-0", "disk_limit; DROP TABLE intent"},
		{"../etc/passwd", "disk_limit"},
		{"sk-full-0'--", "disk_limit"},
		{"", "disk_limit"},
	} {
		if err := store.RecordStopReason(t.Context(), test.container, test.reason, time.Now()); err == nil {
			t.Fatalf("accepted %q %q", test.container, test.reason)
		}
	}
	if reasons, err := store.StopReasons(t.Context()); err != nil || len(reasons) != 0 {
		t.Fatalf("stored %v %v", reasons, err)
	}
}
