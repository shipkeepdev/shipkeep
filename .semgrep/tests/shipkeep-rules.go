// Test cases for the Go rules in .semgrep/shipkeep-rules.yml.
// Each `ruleid:` line must be flagged by the named rule; each `ok:` line must not.
package tests

import (
	"context"
	"os"
	"os/exec"
	"syscall"

	"github.com/docker/docker/api/types/container"
)

func shellInterpreters(ctx context.Context, script string) {
	// ruleid: go-no-shell-interpreter, go-exec-dash-c
	exec.Command("sh", "-c", script)
	// ruleid: go-no-shell-interpreter, go-exec-dash-c
	exec.Command("bash", "-c", script)
	// ruleid: go-no-shell-interpreter, go-exec-dash-c
	exec.Command("/bin/sh", "-c", script)
	// ruleid: go-no-shell-interpreter
	exec.Command("/usr/bin/bash", "-lc", script)
	// ruleid: go-no-shell-interpreter, go-exec-dash-c
	exec.Command("busybox", "sh", "-c", script)
	// ruleid: go-no-shell-interpreter, go-exec-dash-c
	exec.CommandContext(ctx, "zsh", "-c", script)
	// ruleid: go-no-shell-interpreter
	exec.CommandContext(ctx, "/bin/bash", script)
	// ruleid: go-no-shell-interpreter
	exec.Command("powershell.exe", "-Command", script)

	// ok: go-no-shell-interpreter
	exec.Command("pg_dump", "--format=custom", "shipkeep")
	// ok: go-no-shell-interpreter
	exec.CommandContext(ctx, "wg", "show", "shipkeep0")
}

func nonLiteralBinary(ctx context.Context, program string, args []string) {
	// ruleid: go-exec-non-literal-binary
	exec.Command(program, args...)
	// ruleid: go-exec-non-literal-binary
	exec.CommandContext(ctx, program)
	binary := "/usr/bin/" + program
	// ruleid: go-exec-non-literal-binary
	exec.Command(binary)

	// ok: go-exec-non-literal-binary
	exec.Command("pg_dump", args...)
	// ok: go-exec-non-literal-binary
	exec.CommandContext(ctx, "mysqldump", "--single-transaction")
}

func dashC(ctx context.Context, script string) {
	// ruleid: go-exec-dash-c
	exec.Command("python3", "-c", script)
	// ruleid: go-exec-dash-c
	exec.CommandContext(ctx, "perl", "-w", "-c", script)

	// ok: go-exec-dash-c
	exec.Command("pg_dump", "--clean", "shipkeep")
	// ok: go-exec-dash-c
	exec.CommandContext(ctx, "tar", "-czf", "backup.tgz", "data")
}

func rawSpawn(argv []string, env []string) {
	// ruleid: go-no-raw-process-spawn
	syscall.Exec(argv[0], argv, env)
	// ruleid: go-no-raw-process-spawn
	syscall.ForkExec(argv[0], argv, nil)
	// ruleid: go-no-raw-process-spawn
	os.StartProcess(argv[0], argv, &os.ProcAttr{})

	// ok: go-no-raw-process-spawn
	os.Getpid()
}

func containerSpecs(hc *container.HostConfig) *container.HostConfig {
	// ruleid: go-no-privileged-container
	bad := &container.HostConfig{Privileged: true}
	// ruleid: go-no-privileged-container
	hc.Privileged = true
	// ruleid: go-no-privileged-container
	hostPid := &container.HostConfig{PidMode: "host", AutoRemove: true}
	// ruleid: go-no-privileged-container
	hostNet := &container.HostConfig{NetworkMode: "host"}
	// ruleid: go-no-privileged-container
	hostIpc := &container.HostConfig{IpcMode: "host"}
	// ruleid: go-no-privileged-container
	hostUserns := &container.HostConfig{UsernsMode: "host"}
	_, _, _, _, _ = bad, hostPid, hostNet, hostIpc, hostUserns

	// ok: go-no-privileged-container
	good := &container.HostConfig{Privileged: false, NetworkMode: "sk-prod", ReadonlyRootfs: true}
	// ok: go-no-privileged-container
	hc.Privileged = false
	return good
}
