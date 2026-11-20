package agent

import (
	"context"
	"log/slog"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
)

// controlPlaneRouter is the part of the Caddy client that keeps the control plane's route.
type controlPlaneRouter interface {
	EnsureControlPlaneRoute(ctx context.Context, route caddy.Route) (bool, error)
}

// keepControlPlaneRoute applies the control plane's route, then checks it every interval and puts
// it back when Caddy lost or changed it (ADR 0021). It runs from the agent's start, before and
// independently of enrollment, and keeps running during a control plane outage. While Caddy does
// not answer, it retries sooner, from retry up to interval.
func keepControlPlaneRoute(ctx context.Context, router controlPlaneRouter, route caddy.Route, interval, retry time.Duration, logger *slog.Logger) {
	delay := retry
	for {
		changed, err := router.EnsureControlPlaneRoute(ctx, route)
		next := interval
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			// The client reports Caddy's status only, never its configuration text.
			logger.Warn("control plane route not applied yet; retrying", "error", err, "retry_in", delay.String())
			next, delay = delay, min(delay*2, interval)
		case changed:
			logger.Info("control plane route applied", "host", route.Match[0].Host[0])
			delay = retry
		default:
			delay = retry
		}
		timer := time.NewTimer(next)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
