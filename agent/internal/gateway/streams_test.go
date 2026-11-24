package gateway

import (
	"context"
	"errors"
	"testing"
)

func TestNoExecStreamBetweenSessions(t *testing.T) {
	var streams Streams
	if _, err := streams.OpenExec(context.Background()); !errors.Is(err, errNoSession) {
		t.Fatalf("got %v", err)
	}
	streams.use(nil)
	if _, err := streams.OpenExec(context.Background()); !errors.Is(err, errNoSession) {
		t.Fatalf("after a session: %v", err)
	}
}
