// Package logging builds the agent's structured logger (JSON by default, text in --dev).
//
// Secret values must be wrapped in lib/secret types; the logger never sees raw credentials.
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"strings"
)

// New returns a logger writing to w at the given level ("debug", "info", "warn", "error") and
// format ("json" or "text"). Attributes common to every record are added through base.
func New(w io.Writer, level, format string, base ...slog.Attr) (*slog.Logger, error) {
	lvl, err := ParseLevel(level)
	if err != nil {
		return nil, err
	}
	opts := &slog.HandlerOptions{Level: lvl, ReplaceAttr: normalizeTime}
	var handler slog.Handler
	switch format {
	case "json":
		handler = slog.NewJSONHandler(w, opts)
	case "text":
		handler = slog.NewTextHandler(w, opts)
	default:
		return nil, fmt.Errorf("unknown log format %q", format)
	}
	if len(base) > 0 {
		handler = handler.WithAttrs(base)
	}
	return slog.New(handler), nil
}

// ParseLevel converts a configuration string to a slog.Level.
func ParseLevel(level string) (slog.Level, error) {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("unknown log level %q", level)
	}
}

// normalizeTime renders timestamps in RFC 3339 with millisecond precision in UTC so logs from
// every node sort and compare the same way in VictoriaLogs.
func normalizeTime(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 && a.Key == slog.TimeKey && a.Value.Kind() == slog.KindTime {
		a.Value = slog.StringValue(a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
	}
	return a
}
