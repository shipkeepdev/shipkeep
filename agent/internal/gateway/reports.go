package gateway

import (
	"context"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// reportStates samples independently of the stream writer, keeping heartbeats responsive.
// A fresh session starts with a full snapshot. Changes are sampled every second, with a full
// refresh every 30 seconds. Collection failures retain the last good observation remotely.
func (r *Runner) reportStates(ctx context.Context, epoch uint64, output chan<- *agentv1.StateReport, ticks <-chan time.Time) {
	var previous *agentv1.StateReport
	var sentAt time.Time
	for {
		started := time.Now()
		collectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		report, err := r.Report(collectCtx)
		cancel()
		if err == nil && report != nil && proto.Size(report) < 60*1024 {
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
		} else if ctx.Err() == nil {
			r.Logger.Warn("state report collection failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}
