//go:build integration

package actions

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// An ExecSession against a real Docker, with the control plane's side of the stream played by
// the test: stdin in, output and the exit code out.
func TestRealExecSessionRunsInAManagedContainer(t *testing.T) {
	_, streams := execFixture()
	stream := streams.stream
	probe := newRealAgent(t, nil)
	exec := DockerHandlers(probe.engine, acceptAll{}, probe.store, WithoutEgressCheck(), WithExec(DockerExec(probe.engine), streams))["exec_session"]
	agent := newRealAgent(t, map[string]Handler{"exec_session": exec})
	const name = "sk-it-exec-r1-0"
	agent.forget([]string{name}, nil)
	agent.prepare()
	spec := &agentv1.ContainerSpec{Name: name, ImageRef: busyboxImage, Command: []string{"sleep", "300"}, Resources: &agentv1.Resources{CpuMillis: 250, MemoryBytes: 64 << 20}, Network: itNetwork}
	id := agent.must("create", itCreate(spec), time.Minute).GetResult().GetContainerId()
	agent.must("start", itStart(id), time.Minute)

	stream.in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Stdin{Stdin: []byte("echo \"hi $0\"; echo oops >&2; exit 4\n")}}
	stream.in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Close{Close: &agentv1.ExecClose{}}}
	session := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_ExecSession{ExecSession: &agentv1.ExecSession{
		ContainerId: name, Argv: []string{"sh"}, SessionId: "019d0000-0000-7000-8000-0000000000aa", TimeLimit: durationpb.New(time.Minute),
	}}}
	agent.must("exec", session, 2*time.Minute)
	var stdout, stderr string
	var exit *agentv1.ExecExit
	for _, frame := range stream.frames() {
		stdout += string(frame.GetStdout())
		stderr += string(frame.GetStderr())
		if frame.GetExit() != nil {
			exit = frame.GetExit()
		}
	}
	if stdout != "hi sh\n" || stderr != "oops\n" || exit == nil || exit.GetExitCode() != 4 {
		t.Fatalf("stdout %q, stderr %q, exit %v", stdout, stderr, exit)
	}
}
