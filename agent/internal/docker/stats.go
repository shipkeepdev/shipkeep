package docker

import (
	"context"
	"net/http"
	"net/url"
)

// ContainerStats is the part of Docker's stats a metrics report needs (ADR 0024): cumulative CPU
// time, memory and network counters. Nothing else of the answer is decoded.
type ContainerStats struct {
	CPU struct {
		Usage struct {
			// Nanoseconds of CPU time since the container started.
			Total uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
	} `json:"cpu_stats"`
	Memory struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		Received uint64 `json:"rx_bytes"`
		Sent     uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

// ContainerStats reads one sample of a container's stats, without streaming.
func (c *Client) ContainerStats(ctx context.Context, id string) (ContainerStats, error) {
	var stats ContainerStats
	query := url.Values{"stream": {"false"}, "one-shot": {"true"}}
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/stats?"+query.Encode(), nil, &stats); err != nil {
		return ContainerStats{}, err
	}
	return stats, nil
}

// MemoryInUse is the memory a container uses, without the page cache the kernel can reclaim:
// what `docker stats` shows.
func (s ContainerStats) MemoryInUse() uint64 {
	inactive := s.Memory.Stats["inactive_file"]
	if inactive > s.Memory.Usage {
		return 0
	}
	return s.Memory.Usage - inactive
}

// DataRoot is the directory where Docker keeps images, containers and volumes.
func (c *Client) DataRoot(ctx context.Context) (string, error) {
	var info struct {
		DockerRootDir string `json:"DockerRootDir"`
	}
	if err := c.do(ctx, http.MethodGet, "/info", nil, &info); err != nil {
		return "", err
	}
	return info.DockerRootDir, nil
}
