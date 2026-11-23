package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"time"
)

// Bounds of what an upgrade downloads and unpacks.
const (
	// MaxArchiveBytes bounds an agent archive: about 10 MiB today.
	MaxArchiveBytes = 64 << 20
	// MaxBinaryBytes bounds the agent binary inside it.
	MaxBinaryBytes = 128 << 20
	// DownloadTimeout bounds one download, redirects included.
	DownloadTimeout = 10 * time.Minute
	maxRedirects    = 5
	maxEntries      = 64
)

// The hosts a release download may go through: GitHub, then its release storage.
var downloadHosts = map[string]bool{
	"github.com":                           true,
	"objects.githubusercontent.com":        true,
	"release-assets.githubusercontent.com": true,
}

// Client returns the HTTP client downloads use: HTTPS only, and redirects only to GitHub's
// release hosts, at most five.
func Client() *http.Client {
	return &http.Client{
		Timeout: DownloadTimeout,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("%w: too many redirects", ErrRefused)
			}
			return allowed(request.URL)
		},
	}
}

func allowed(address *url.URL) error {
	if address.Scheme != "https" || address.User != nil || !downloadHosts[address.Hostname()] || (address.Port() != "" && address.Port() != "443") {
		return fmt.Errorf("%w: a release is only downloaded from GitHub over HTTPS", ErrRefused)
	}
	return nil
}

// Download reads address, which must be a GitHub release address, into memory, refusing anything
// larger than limit bytes.
func Download(ctx context.Context, client *http.Client, address string, limit int64) ([]byte, error) {
	parsed, err := url.Parse(address)
	if err != nil {
		return nil, fmt.Errorf("%w: not an address", ErrRefused)
	}
	if err := allowed(parsed); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("download request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: GitHub answered %d", response.StatusCode)
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("%w: the download is larger than %d bytes", ErrRefused, limit)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: the download is larger than %d bytes", ErrRefused, limit)
	}
	return data, nil
}

// ExtractAgent returns the `shipkeep-agent` binary of a release archive: a regular file at the
// archive's root, present once. Any other entry is skipped unread, but one that tries to escape
// (an absolute path, `..`) refuses the whole archive.
func ExtractAgent(archive []byte) ([]byte, error) {
	unzipped, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("%w: the archive is not gzip", ErrRefused)
	}
	defer unzipped.Close() //nolint:errcheck // in-memory reader
	entries := tar.NewReader(unzipped)
	var binary []byte
	for count := 0; ; count++ {
		if count >= maxEntries {
			return nil, fmt.Errorf("%w: the archive has more than %d entries", ErrRefused, maxEntries)
		}
		header, err := entries.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%w: the archive cannot be read", ErrRefused)
		}
		name := path.Clean(header.Name)
		if path.IsAbs(header.Name) || name == ".." || len(name) > 2 && name[:3] == "../" {
			return nil, fmt.Errorf("%w: an entry of the archive leaves it", ErrRefused)
		}
		if name != "shipkeep-agent" {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%w: shipkeep-agent is not a regular file", ErrRefused)
		}
		if binary != nil {
			return nil, fmt.Errorf("%w: the archive holds shipkeep-agent twice", ErrRefused)
		}
		if header.Size <= 0 || header.Size > MaxBinaryBytes {
			return nil, fmt.Errorf("%w: shipkeep-agent is empty or larger than %d bytes", ErrRefused, MaxBinaryBytes)
		}
		binary, err = io.ReadAll(io.LimitReader(entries, header.Size+1))
		if err != nil || int64(len(binary)) != header.Size {
			return nil, fmt.Errorf("%w: shipkeep-agent is cut short", ErrRefused)
		}
	}
	if binary == nil {
		return nil, fmt.Errorf("%w: the archive holds no shipkeep-agent", ErrRefused)
	}
	return binary, nil
}
