package commands

import (
	"context"
	"fmt"
	"text/tabwriter"

	"github.com/shipkeepdev/shipkeep/cli/internal/client"
)

type application struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type deployment struct {
	ID        string  `json:"id"`
	ReleaseID string  `json:"releaseId"`
	State     string  `json:"state"`
	Error     *string `json:"error"`
}

type replica struct {
	Replica  int     `json:"replica"`
	NodeName string  `json:"nodeName"`
	State    *string `json:"state"`
}

func (a *App) status(ctx context.Context, args []string) error {
	set := a.flags("status")
	where := a.targetFlags(set)
	only := set.String("app", "", "show only this application")
	if err := parse(set, args); err != nil {
		return err
	}
	path, err := where.path()
	if err != nil {
		return err
	}
	api, err := a.connect()
	if err != nil {
		return err
	}
	var applications struct {
		Items []application `json:"items"`
	}
	if err := api.Do(ctx, "GET", path+"/applications", nil, &applications); err != nil {
		return err
	}
	table := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(table, "APPLICATION\tDEPLOYMENT\tREPLICAS")
	shown := 0
	for _, item := range applications.Items {
		if *only != "" && item.Name != *only {
			continue
		}
		// The ID came from the API; it still decides a URL, so it is checked like any other.
		if !resourceID.MatchString(item.ID) {
			return fmt.Errorf("the control plane sent an invalid application ID")
		}
		base := path + "/applications/" + item.ID
		var deployments struct {
			Items []deployment `json:"items"`
		}
		if err := api.Do(ctx, "GET", base+"/deployments", nil, &deployments); err != nil {
			return err
		}
		var replicas struct {
			Items []replica `json:"items"`
		}
		if err := api.Do(ctx, "GET", base+"/replicas", nil, &replicas); err != nil {
			return err
		}
		state := "none"
		if len(deployments.Items) > 0 {
			state = deployments.Items[0].State
		}
		_, _ = fmt.Fprintf(table, "%s\t%s\t%s\n",
			client.Clean(item.Name), client.Clean(state), replicaSummary(replicas.Items))
		shown++
	}
	if err := table.Flush(); err != nil {
		return fmt.Errorf("write the table: %w", err)
	}
	if *only != "" && shown == 0 {
		return fmt.Errorf("no application is named %q here", client.Clean(*only))
	}
	return nil
}

// replicaSummary counts replicas by what their agent last reported.
func replicaSummary(items []replica) string {
	if len(items) == 0 {
		return "0"
	}
	running := 0
	for _, item := range items {
		if item.State != nil && *item.State == "running" {
			running++
		}
	}
	return fmt.Sprintf("%d of %d running", running, len(items))
}
