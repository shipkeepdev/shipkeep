// Package client talks to the public REST API of a Shipkeep control plane with an API token.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const (
	requestTimeout = 30 * time.Second
	// Largest response read; every answer this CLI expects is far smaller.
	maxResponseBytes = 4 << 20
)

// Client sends authenticated requests to one control plane. Create it with New.
type Client struct {
	base  *url.URL
	token secret.String
	http  *http.Client
}

// ParseURL checks a control plane address. The token travels with every request, so plain HTTP is
// refused except on the loopback interface, and the address can hold nothing but scheme and host.
func ParseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil {
		return nil, errors.New("the control plane URL is not valid")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		parsed.Path != "" {
		return nil, errors.New("the control plane URL must look like https://shipkeep.example.com")
	}
	switch parsed.Scheme {
	case "https":
		return parsed, nil
	case "http":
		if isLoopback(parsed.Hostname()) {
			return parsed, nil
		}
		return nil, errors.New("the control plane URL must use https: a token would travel in clear")
	default:
		return nil, errors.New("the control plane URL must use https")
	}
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// New returns a client for an address already checked by ParseURL.
func New(base *url.URL, token secret.String) *Client {
	return &Client{
		base:  base,
		token: token,
		http: &http.Client{
			// Never follow a redirect: it could carry the token elsewhere, and the API sends none.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// ProblemError is an RFC 9457 error answer from the API.
type ProblemError struct {
	Status int
	Code   string
	Detail string
}

func (p *ProblemError) Error() string {
	text := p.Detail
	if text == "" {
		text = http.StatusText(p.Status)
	}
	if p.Code != "" {
		return fmt.Sprintf("%s (%s)", Clean(text), Clean(p.Code))
	}
	return Clean(text)
}

// Clean removes control characters from text the server sent, so that a response cannot rewrite
// the terminal it is printed on.
func Clean(text string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || (r >= 0x7f && r < 0xa0) || r == 0x2028 || r == 0x2029 ||
			(r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return -1
		}
		return r
	}, text)
}

// Do sends a request. A non-nil body is sent as JSON, a non-nil out receives the JSON answer, and
// any answer outside 2xx is returned as a *ProblemError.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}
	target := *c.base
	parsedPath, err := url.Parse(path)
	if err != nil {
		return errors.New("the request path is not valid")
	}
	target.Path = parsedPath.Path
	target.RawPath = parsedPath.RawPath
	target.RawQuery = parsedPath.RawQuery

	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil {
		return errors.New("the request could not be created")
	}
	request.Header.Set("Authorization", "Bearer "+c.token.Expose())
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(request)
	if err != nil {
		// A *url.Error names the address, never a header, so the token cannot appear here.
		return fmt.Errorf("the control plane could not be reached: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read the answer: %w", err)
	}
	if len(data) > maxResponseBytes {
		return errors.New("the answer from the control plane is too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return problemFrom(response.StatusCode, data)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("the answer from the control plane is not valid: %w", err)
	}
	return nil
}

func problemFrom(status int, data []byte) *ProblemError {
	var document struct {
		Code   string `json:"code"`
		Detail string `json:"detail"`
		Title  string `json:"title"`
	}
	if json.Unmarshal(data, &document) != nil {
		return &ProblemError{Status: status}
	}
	detail := document.Detail
	if detail == "" {
		detail = document.Title
	}
	return &ProblemError{Status: status, Code: document.Code, Detail: detail}
}
