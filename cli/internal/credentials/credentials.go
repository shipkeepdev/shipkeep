// Package credentials keeps the control plane address and API token of the current user.
package credentials

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const fileName = "credentials.json"

// Stored is what login saved. The token redacts itself if it is ever formatted or logged.
type Stored struct {
	URL   string        `json:"url"`
	Token secret.String `json:"-"`
}

type onDisk struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// ErrNotLoggedIn means no credentials are stored.
var ErrNotLoggedIn = errors.New("not logged in: run `shipkeep login` first")

// Path returns the file holding the credentials, under the user's configuration directory.
func Path() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find the configuration directory: %w", err)
	}
	return filepath.Join(directory, "shipkeep", fileName), nil
}

// Save writes the credentials atomically, readable by the current user only.
func Save(path string, stored Stored) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", directory, err)
	}
	data, err := json.Marshal(onDisk{URL: stored.URL, Token: stored.Token.Expose()})
	if err != nil {
		return errors.New("the credentials could not be encoded")
	}
	file, err := os.CreateTemp(directory, fileName+".*")
	if err != nil {
		return fmt.Errorf("create a file in %s: %w", directory, err)
	}
	defer func() { _ = os.Remove(file.Name()) }()
	// CreateTemp already uses 0600. Stating it keeps that from depending on an implementation detail.
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("protect the credentials file: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write the credentials file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write the credentials file: %w", err)
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("save the credentials file: %w", err)
	}
	return nil
}

// Load reads the credentials. A file other users can read is refused rather than used: the token
// in it must be considered exposed.
func Load(path string) (Stored, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Stored{}, ErrNotLoggedIn
	}
	if err != nil {
		return Stored{}, fmt.Errorf("read the credentials file: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Stored{}, fmt.Errorf(
			"%s can be read by other users: revoke the token, delete the file and log in again", path)
	}
	data, err := os.ReadFile(path) // #nosec G304 -- the path is under the user's own config directory.
	if err != nil {
		return Stored{}, fmt.Errorf("read the credentials file: %w", err)
	}
	var document onDisk
	if err := json.Unmarshal(data, &document); err != nil || document.Token == "" {
		// The JSON error could quote the file's content, so it is not wrapped.
		return Stored{}, fmt.Errorf("%s is not valid: log in again", path)
	}
	return Stored{URL: document.URL, Token: secret.NewString(document.Token)}, nil
}

// Remove deletes the stored credentials; having none is not an error.
func Remove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete the credentials file: %w", err)
	}
	return nil
}
