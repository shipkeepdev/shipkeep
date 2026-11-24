package upgrade

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The binary's siblings, next to it in the agent's own bin directory (ADR 0028).
const (
	nextSuffix     = ".next"
	previousSuffix = ".previous"
	pendingFile    = "upgrade.json"
	binaryName     = "shipkeep-agent"
)

// Pending states.
const (
	// StatePending: the new binary is in place; it has not completed a Hello yet.
	StatePending = "pending"
	// StateRolledBack: the upgrade guard put the previous binary back.
	StateRolledBack = "rolled-back"
)

// MaxAttempts is how many starts the new binary gets before the guard puts the previous one back.
const MaxAttempts = 3

// Pending is the record of an upgrade in progress, in the agent's state directory. The agent and
// the upgrade guard both run as the agent's user and read it from there. The guard runs from the
// installer's copy of the agent, which an upgrade never replaces, so this format stays stable:
// new fields may be added, none renamed or removed.
type Pending struct {
	From     string    `json:"from"`
	To       string    `json:"to"`
	Binary   string    `json:"binary"`
	SHA256   string    `json:"sha256"`
	At       time.Time `json:"at"`
	State    string    `json:"state"`
	Attempts int       `json:"attempts"`
}

// ReadPending returns the upgrade record, and false when there is none.
func ReadPending(stateDir string) (Pending, bool, error) {
	data, err := os.ReadFile(filepath.Join(stateDir, pendingFile)) //nolint:gosec // a fixed name in the agent's own state directory
	if errors.Is(err, os.ErrNotExist) {
		return Pending{}, false, nil
	}
	if err != nil {
		return Pending{}, false, fmt.Errorf("read upgrade record: %w", err)
	}
	var record Pending
	if len(data) > 4096 || json.Unmarshal(data, &record) != nil || record.check() != nil {
		return Pending{}, false, errors.New("the upgrade record cannot be read")
	}
	return record, true, nil
}

// check refuses a record that names a binary other than an agent binary path: rollback-agent
// renames files next to it, so the path must be the agent's own.
func (p Pending) check() error {
	if !filepath.IsAbs(p.Binary) || filepath.Clean(p.Binary) != p.Binary || filepath.Base(p.Binary) != binaryName {
		return errors.New("the upgrade record names no agent binary")
	}
	if p.State != StatePending && p.State != StateRolledBack {
		return errors.New("the upgrade record has no known state")
	}
	if p.Attempts < 0 || p.Attempts > 1000 {
		return errors.New("the upgrade record counts no plausible attempts")
	}
	return nil
}

// WritePending records an upgrade, replacing the record atomically.
func WritePending(stateDir string, record Pending) error {
	if err := record.check(); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode upgrade record: %w", err)
	}
	return writeFile(filepath.Join(stateDir, pendingFile), data, 0o600)
}

// ClearPending forgets the upgrade record. A missing record is already forgotten.
func ClearPending(stateDir string) error {
	if err := os.Remove(filepath.Join(stateDir, pendingFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear upgrade record: %w", err)
	}
	return syncDir(stateDir)
}

// WriteNext writes the verified binary next to the running one, as `<binary>.next`, mode 0755,
// synced to disk before it can take its place.
func WriteNext(binary string, data []byte) error {
	return writeFile(binary+nextSuffix, data, 0o755)
}

// LinkPrevious gives the running binary a second name, `<binary>.previous`, with a hard link:
// it never leaves its own path. The link is made under `.previous.new`, then renamed onto
// `.previous` in one step, so an older `.previous` is replaced and a later upgrade works too.
func LinkPrevious(binary string) error {
	previous := binary + previousSuffix
	staged := previous + ".new"
	if err := os.Remove(staged); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove a stale %s: %w", filepath.Base(staged), err)
	}
	if err := os.Link(binary, staged); err != nil {
		return fmt.Errorf("keep the running binary: %w", err)
	}
	if err := os.Rename(staged, previous); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("keep the running binary: %w", err)
	}
	return syncDir(filepath.Dir(binary))
}

// Swap renames `.next` onto the binary, in one step. Run again once it happened, it finds no
// `.next` and a binary whose digest is want, and succeeds.
func Swap(binary, want string) error {
	if err := os.Rename(binary+nextSuffix, binary); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if got, digestErr := FileSHA256(binary); digestErr == nil && got == want {
				return nil
			}
		}
		return fmt.Errorf("put the new binary in place: %w", err)
	}
	return syncDir(filepath.Dir(binary))
}

// Unswap undoes a swap that may have happened. When the binary is the new one of record, it
// renames `.previous`, the running binary's other name, back onto it. When the binary is another
// one, the swap never happened and nothing is undone. It fails, and changes nothing, when the new
// binary is in place but no previous one is there: the record must then stay, for the guard.
func Unswap(record Pending) error {
	if err := record.check(); err != nil {
		return err
	}
	got, err := FileSHA256(record.Binary)
	if err != nil {
		return err
	}
	if got != record.SHA256 {
		return nil
	}
	previous := record.Binary + previousSuffix
	info, err := os.Lstat(previous)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("the new binary is in place, but no previous binary is there to go back to")
	}
	if err := os.Rename(previous, record.Binary); err != nil {
		return fmt.Errorf("put the running binary back: %w", err)
	}
	return syncDir(filepath.Dir(record.Binary))
}

// Guard is what the upgrade guard does before each start of the agent (ADR 0028). Without a
// pending upgrade it does nothing. With one, it counts this start; once the new binary has had
// MaxAttempts starts without completing a Hello, it renames `.previous` back onto the binary and
// records the rollback, so that the previous binary starts. It reports whether it rolled back.
func Guard(stateDir string) (bool, error) {
	record, found, err := ReadPending(stateDir)
	if err != nil || !found || record.State != StatePending {
		return false, err
	}
	record.Attempts++
	if record.Attempts <= MaxAttempts {
		return false, WritePending(stateDir, record)
	}
	previous := record.Binary + previousSuffix
	info, err := os.Lstat(previous)
	if err != nil || !info.Mode().IsRegular() {
		return false, errors.New("an upgrade keeps failing, but no previous binary is there to go back to")
	}
	if err := os.Rename(previous, record.Binary); err != nil {
		return false, fmt.Errorf("put the previous binary back: %w", err)
	}
	if err := syncDir(filepath.Dir(record.Binary)); err != nil {
		return false, err
	}
	record.State = StateRolledBack
	return true, WritePending(stateDir, record)
}

// FileSHA256 is the hex SHA-256 of a file no larger than an agent binary may be.
func FileSHA256(path string) (string, error) {
	file, err := os.Open(path) //nolint:gosec // the agent's own binary
	if err != nil {
		return "", fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer file.Close() //nolint:errcheck // read-only
	hash := sha256.New()
	read, err := io.Copy(hash, io.LimitReader(file, MaxBinaryBytes+1))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	// A digest of the first bytes alone would make two different files look the same.
	if read > MaxBinaryBytes {
		return "", fmt.Errorf("%w: %s is larger than %d bytes", ErrRefused, filepath.Base(path), MaxBinaryBytes)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// BinaryPath is the path of the running binary, symbolic links resolved. It must be named
// shipkeep-agent: the upgrade writes its siblings next to it.
func BinaryPath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find the running binary: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("find the running binary: %w", err)
	}
	if filepath.Base(resolved) != binaryName || strings.ContainsAny(resolved, "\n\r") {
		return "", fmt.Errorf("%w: the running binary is not named %s", ErrRefused, binaryName)
	}
	return resolved, nil
}

// writeFile writes data under a temporary name, syncs it, then renames it onto path.
func writeFile(path string, data []byte, mode os.FileMode) error {
	temporary := path + ".writing"
	if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", filepath.Base(temporary), err)
	}
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode) //nolint:gosec // next to the agent's own files
	if err != nil {
		return fmt.Errorf("create %s: %w", filepath.Base(temporary), err)
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("write %s: %w", filepath.Base(path), err)
	}
	// The mode is set again: the umask may have narrowed it.
	if err := os.Chmod(temporary, mode); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("set the mode of %s: %w", filepath.Base(path), err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("rename %s: %w", filepath.Base(path), err)
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(dir string) error {
	handle, err := os.Open(dir) //nolint:gosec // the agent's own directory
	if err != nil {
		return fmt.Errorf("open %s: %w", dir, err)
	}
	defer handle.Close() //nolint:errcheck // read-only
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	return nil
}
