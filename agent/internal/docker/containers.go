package docker

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// Container is the subset of an inspected container the agent relies on.
type Container struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Running  bool   `json:"Running"`
		Status   string `json:"Status"`
		ExitCode int    `json:"ExitCode"`
	} `json:"State"`
}

// ContainerConfig is the typed create body. Fields that could escape the sandbox (privileged
// mode, host namespaces, devices, bind mounts) do not exist in this struct and cannot be set.
type ContainerConfig struct {
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd,omitempty"`
	WorkingDir   string              `json:"WorkingDir,omitempty"`
	Env          []string            `json:"Env,omitempty"`
	User         string              `json:"User,omitempty"`
	Labels       map[string]string   `json:"Labels"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	StopTimeout  *int                `json:"StopTimeout,omitempty"`
	HostConfig   HostConfig          `json:"HostConfig"`
}

// HostConfig carries only the confinement and resource settings the agent decides.
type HostConfig struct {
	NetworkMode    string            `json:"NetworkMode"`
	Mounts         []Mount           `json:"Mounts,omitempty"`
	DNS            []string          `json:"Dns,omitempty"`
	CapAdd         []string          `json:"CapAdd,omitempty"`
	SecurityOpt    []string          `json:"SecurityOpt"`
	ReadonlyRootfs bool              `json:"ReadonlyRootfs"`
	NanoCPUs       int64             `json:"NanoCpus,omitempty"`
	Memory         int64             `json:"Memory,omitempty"`
	PidsLimit      int64             `json:"PidsLimit"`
	RestartPolicy  RestartPolicy     `json:"RestartPolicy"`
	IpcMode        string            `json:"IpcMode"`
	Init           bool              `json:"Init"`
	LogConfig      map[string]any    `json:"LogConfig,omitempty"`
	Tmpfs          map[string]string `json:"Tmpfs,omitempty"`
}

// Mount is a volume or tmpfs mount; the bind type is never produced by the agent.
type Mount struct {
	Type         string        `json:"Type"`
	Source       string        `json:"Source,omitempty"`
	Target       string        `json:"Target"`
	ReadOnly     bool          `json:"ReadOnly"`
	TmpfsOptions *TmpfsOptions `json:"TmpfsOptions,omitempty"`
}

// TmpfsOptions bound an in-memory mount.
type TmpfsOptions struct {
	SizeBytes int64 `json:"SizeBytes,omitempty"`
	Mode      int   `json:"Mode,omitempty"`
}

// RestartPolicy is Docker's restart policy.
type RestartPolicy struct {
	Name              string `json:"Name"`
	MaximumRetryCount int    `json:"MaximumRetryCount,omitempty"`
}

// Container inspects a container by name or id. Names starting with `sk-` cannot be confused with
// hexadecimal id prefixes.
func (c *Client) Container(ctx context.Context, ref string) (Container, error) {
	var container Container
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(ref)+"/json", nil, &container); err != nil {
		return Container{}, err
	}
	return container, nil
}

// CreateContainer creates (never starts) a container named name.
func (c *Client) CreateContainer(ctx context.Context, name string, config ContainerConfig) (string, error) {
	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), config, &created); err != nil {
		return "", err
	}
	return created.ID, nil
}

// StartContainer starts a created container; an already running one is left as is.
func (c *Client) StartContainer(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil)
}

// StopContainer stops a container, killing it after timeout seconds.
func (c *Client) StopContainer(ctx context.Context, id string, timeout int) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/stop?t="+strconv.Itoa(timeout), nil, nil)
}

// RemoveContainer force-removes a container, and its anonymous volumes when volumes is true.
func (c *Client) RemoveContainer(ctx context.Context, id string, volumes bool) error {
	query := url.Values{"force": {"true"}, "v": {strconv.FormatBool(volumes)}}
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id)+"?"+query.Encode(), nil, nil)
}
