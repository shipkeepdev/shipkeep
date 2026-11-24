//go:build integration

package docker

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A container that writes three lines, one on stderr, and one longer than Docker's 16 KiB buffer.
func TestRealFollowLogsResumesFromACursor(t *testing.T) {
	client := realClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	repository, digest, _ := strings.Cut(realBusybox, "@")
	if err := client.PullImage(ctx, repository, digest, nil); err != nil {
		t.Fatal(err)
	}
	script := `echo one; echo two >&2; head -c 20000 /dev/zero | tr '\0' x; echo; echo three`
	id, err := client.CreateContainer(ctx, "", ContainerConfig{
		Image: realBusybox, Cmd: []string{"sh", "-c", script}, Labels: map[string]string{"sk.test": "logs"},
		HostConfig: HostConfig{NetworkMode: "none", SecurityOpt: []string{"no-new-privileges"}, PidsLimit: 64},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.RemoveContainer(context.Background(), id, true) })
	if err := client.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	var lines []LogLine
	// The output ends when the container stops: following returns.
	if err := client.FollowLogs(ctx, id, time.Time{}, func(line LogLine) error {
		lines = append(lines, line)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(lines) != 4 || lines[0].Text != "one" || lines[1].Text != "two" || lines[1].Stream != Stderr || lines[3].Text != "three" {
		t.Fatalf("got %d lines: %+v", len(lines), summary(lines))
	}
	if len(lines[2].Text) != MaxLogLine || !lines[2].Truncated {
		t.Fatalf("long line: %d bytes, truncated %v", len(lines[2].Text), lines[2].Truncated)
	}
	// From the timestamp of the third line on, as after an outage: it comes again, then the last.
	var again []LogLine
	if err := client.FollowLogs(ctx, id, lines[2].Time, func(line LogLine) error {
		again = append(again, line)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(again) != 2 || again[1].Text != "three" {
		t.Fatalf("resumed: %+v", summary(again))
	}
}

func summary(lines []LogLine) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		text := line.Text
		if len(text) > 20 {
			text = text[:20] + "…"
		}
		out = append(out, text)
	}
	return out
}
