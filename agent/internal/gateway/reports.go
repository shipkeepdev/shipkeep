package gateway

import (
	"context"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// MaxReportBytes bounds a state report: a larger one is not sent, and the control plane keeps the
// last observation it had.
const MaxReportBytes = 60 * 1024

// reportMetrics sends a metrics report at each tick of ticks (ADR 0024). A sample that fails or
// does not fit is skipped, logged when the failures start and when they end; nothing is kept for
// later, since an outage only leaves a gap in the series.
func (r *Runner) reportMetrics(ctx context.Context, epoch uint64, output chan<- *agentv1.MetricsReport, ticks <-chan time.Time) {
	failing := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
		sampleCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		sample, err := r.Metrics(sampleCtx)
		cancel()
		if err != nil || sample == nil || proto.Size(sample) >= MaxReportBytes {
			if ctx.Err() == nil && !failing {
				failing = true
				r.Logger.Warn("metrics not sampled")
			}
			continue
		}
		if failing {
			failing = false
			r.Logger.Info("metrics sampled again")
		}
		sample.LeaseEpoch = epoch
		select {
		case output <- sample:
		case <-ctx.Done():
			return
		}
	}
}

// reportStates samples independently of the stream writer, keeping heartbeats responsive.
// A fresh session starts with a full snapshot. Changes are sampled every second, with a full
// refresh every 30 seconds. Collection failures retain the last good observation remotely and are
// logged when they start and when they end, not on every sample.
func (r *Runner) reportStates(ctx context.Context, epoch uint64, output chan<- *agentv1.StateReport, ticks <-chan time.Time) {
	var previous *agentv1.StateReport
	var sentAt time.Time
	failing := false
	for {
		started := time.Now()
		collectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		report, err := r.Report(collectCtx)
		cancel()
		if err == nil && report != nil && proto.Size(report) < MaxReportBytes {
			if failing {
				failing = false
				r.Logger.Info("state report collection recovered")
			}
			report = proto.CloneOf(report)
			if !proto.Equal(previous, report) || time.Since(sentAt) >= 30*time.Second {
				previous = proto.CloneOf(report)
				report.LeaseEpoch, report.ObservedAt = epoch, timestamppb.New(started)
				select {
				case output <- report:
					sentAt = time.Now()
				case <-ctx.Done():
					return
				}
			}
		} else if ctx.Err() == nil && !failing {
			failing = true
			r.Logger.Warn("state report collection failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}
