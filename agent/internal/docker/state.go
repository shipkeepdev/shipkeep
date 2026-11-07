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
