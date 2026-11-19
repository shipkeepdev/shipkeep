package docker

import (
	"context"
	"net/http"
	"net/url"
)

// ContainerSummary deliberately excludes environment, commands and arbitrary inspect data.
type ContainerSummary struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	State  string            `json:"State"`
	Labels map[string]string `json:"Labels"`
	// SizeRw is the size of the container's writable layer, only in ManagedContainersWithSize.
	SizeRw int64 `json:"SizeRw"`
}

// ManagedContainers includes stopped containers; an Engine failure never becomes an empty list.
func (c *Client) ManagedContainers(ctx context.Context) ([]ContainerSummary, error) {
	query := url.Values{"all": {"true"}, "filters": {`{"label":["sk.managed=true"]}`}}
	var containers []ContainerSummary
	if err := c.do(ctx, http.MethodGet, "/containers/json?"+query.Encode(), nil, &containers); err != nil {
		return nil, err
	}
	return containers, nil
}

// ManagedContainersWithSize also reports each writable layer's size (SizeRw). Docker walks every
// layer to compute it, so callers ask for it rarely (ADR 0022: once a minute).
func (c *Client) ManagedContainersWithSize(ctx context.Context) ([]ContainerSummary, error) {
	query := url.Values{"all": {"true"}, "size": {"true"}, "filters": {`{"label":["sk.managed=true"]}`}}
	var containers []ContainerSummary
	if err := c.do(ctx, http.MethodGet, "/containers/json?"+query.Encode(), nil, &containers); err != nil {
		return nil, err
	}
	return containers, nil
}
