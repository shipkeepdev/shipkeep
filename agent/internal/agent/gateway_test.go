package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJoinTokenFilesArePrivateBoundedAndNeverEchoed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "join-token")
	token := strings.Repeat("a", 43)
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := readJoinToken(path)
	if err != nil || loaded.Expose() != token {
		t.Fatal("cannot read private token file")
	}
	// Deliberately insecure fixture to exercise permission rejection.
	if err := os.Chmod(path, 0o644); err != nil { //nolint:gosec // deliberately insecure test fixture
		t.Fatal(err)
	}
	if _, err := readJoinToken(path); err == nil || strings.Contains(err.Error(), token) {
		t.Fatal("accepted loose permissions or leaked token")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", path); err != nil {
		t.Fatal(err)
	}
	if _, err := readJoinToken(path); err == nil {
		t.Fatal("accepted symbolic link")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("a", 45)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readJoinToken(path); err == nil {
		t.Fatal("accepted oversized token file")
	}
}
