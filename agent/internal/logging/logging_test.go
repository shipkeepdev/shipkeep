package logging_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/logging"
	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

func TestJSONLoggerWritesOneObjectPerLine(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logger, err := logging.New(&buf, "info", "json", slog.String("component", "agent"))
	if err != nil {
		t.Fatal(err)
	}
	logger.Debug("hidden")
	logger.Info("started", "version", "0.1.0", "token", secret.NewString("sk_fake_abc"))

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %q", len(lines), buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatalf("line is not JSON: %v", err)
	}
	if rec["msg"] != "started" || rec["component"] != "agent" || rec["version"] != "0.1.0" {
		t.Fatalf("record = %v", rec)
	}
	if rec["token"] != secret.Redacted || strings.Contains(lines[0], "sk_fake_abc") {
		t.Fatalf("secret leaked: %s", lines[0])
	}
	ts, _ := rec["time"].(string)
	if !strings.HasSuffix(ts, "Z") || len(ts) != len("2006-01-02T15:04:05.000Z") {
		t.Fatalf("time = %q, want UTC RFC 3339 with milliseconds", ts)
	}
}

func TestTextLoggerAndLevels(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logger, err := logging.New(&buf, "warn", "text")
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("ignored")
	logger.Warn("kept")
	if !strings.Contains(buf.String(), "kept") || strings.Contains(buf.String(), "ignored") {
		t.Fatalf("output = %q", buf.String())
	}
}

func TestInvalidOptions(t *testing.T) {
	t.Parallel()
	if _, err := logging.New(&bytes.Buffer{}, "loud", "json"); err == nil {
		t.Fatal("bad level accepted")
	}
	if _, err := logging.New(&bytes.Buffer{}, "info", "xml"); err == nil {
		t.Fatal("bad format accepted")
	}
}
