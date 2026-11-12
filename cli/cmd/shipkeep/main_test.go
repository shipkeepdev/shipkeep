package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
)

func TestRunVersion(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"--version"}, os.Stdin, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), "shipkeep ") {
		t.Fatalf("stdout = %q, want version line", stdout.String())
	}
}

func TestRunWithoutArgumentsShowsUsage(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), nil, os.Stdin, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "Usage: shipkeep") {
		t.Fatalf("stderr = %q, want usage", stderr.String())
	}
}

func TestRunUnknownCommand(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"\x1b[31mdeploy-everything"}, os.Stdin, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if strings.ContainsRune(stderr.String(), '\x1b') {
		t.Fatal("an escape sequence from the command line reached the terminal")
	}
}
