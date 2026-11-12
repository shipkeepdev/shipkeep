package commands

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/shipkeepdev/shipkeep/cli/internal/client"
	"github.com/shipkeepdev/shipkeep/lib/config"
)

const (
	defaultPollEvery = 2 * time.Second
	defaultWait      = 15 * time.Minute
)

type queuedDeployment struct {
	Deployment deployment `json:"deployment"`
}

// localConfig reads and validates shipkeep.yml before anything reaches the control plane.
func localConfig(file string) (any, string, error) {
	data, err := os.ReadFile(file) // #nosec G304 -- a file the user names, sent only to their own control plane.
	if err != nil {
		return nil, "", fmt.Errorf("read the configuration: %w", err)
	}
	value, err := config.Parse(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s is not valid: %w", file, err)
	}
	if err := config.Validate(value); err != nil {
		return nil, "", fmt.Errorf("%s is not valid: %w", file, err)
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, "", fmt.Errorf("%s is not valid", file)
	}
	name, _ := document["name"].(string)
	return value, name, nil
}

type applicationDetails struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ConfigSHA string `json:"configSha"`
}

// findApplication returns nil when the environment holds no application with this name.
func findApplication(ctx context.Context, api *client.Client, path, name string) (*applicationDetails, error) {
	var answer struct {
		Items []applicationDetails `json:"items"`
	}
	if err := api.Do(ctx, "GET", path+"/applications", nil, &answer); err != nil {
		return nil, err
	}
	for index := range answer.Items {
		if answer.Items[index].Name != name {
			continue
		}
		if !resourceID.MatchString(answer.Items[index].ID) {
			return nil, errors.New("the control plane sent an invalid application ID")
		}
		return &answer.Items[index], nil
	}
	return nil, nil //nolint:nilnil // Absence is an expected answer here, not a failure.
}

func (a *App) waitFlags(set *flag.FlagSet) (*bool, *time.Duration) {
	return set.Bool("no-wait", false, "return once the deployment is queued"),
		set.Duration("timeout", defaultWait, "how long to follow the deployment")
}

func (a *App) deploy(ctx context.Context, args []string) error {
	set := a.flags("deploy")
	where := a.targetFlags(set)
	file := set.String("file", "shipkeep.yml", "configuration file")
	noWait, timeout := a.waitFlags(set)
	if err := parse(set, args); err != nil {
		return err
	}
	path, err := where.path()
	if err != nil {
		return err
	}
	value, name, err := localConfig(*file)
	if err != nil {
		return err
	}
	api, err := a.connect()
	if err != nil {
		return err
	}
	current, err := findApplication(ctx, api, path, name)
	if err != nil {
		return err
	}
	var saved applicationDetails
	if current == nil {
		err = api.Do(ctx, "POST", path+"/applications", map[string]any{"config": value}, &saved)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(a.Out, "Created application %s.\n", client.Clean(name))
	} else {
		// Saving an unchanged configuration changes and records nothing on the server.
		body := map[string]any{"config": value, "expectedConfigSha": current.ConfigSHA}
		err = api.Do(ctx, "POST", path+"/applications/"+current.ID+"/config", body, &saved)
		if err != nil {
			return err
		}
	}
	if !resourceID.MatchString(saved.ID) {
		return errors.New("the control plane sent an invalid application ID")
	}
	base := path + "/applications/" + saved.ID
	var queued queuedDeployment
	if err := api.Do(ctx, "POST", base+"/deployments", nil, &queued); err != nil {
		return err
	}
	return a.follow(ctx, api, base, queued.Deployment, *noWait, *timeout)
}

func (a *App) rollback(ctx context.Context, args []string) error {
	set := a.flags("rollback")
	where := a.targetFlags(set)
	file := set.String("file", "shipkeep.yml", "configuration file naming the application")
	named := set.String("app", "", "application name, instead of reading the file")
	to := set.String("to", "", "deployment to return to; by default the last good one before the current release")
	noWait, timeout := a.waitFlags(set)
	if err := parse(set, args); err != nil {
		return err
	}
	path, err := where.path()
	if err != nil {
		return err
	}
	if *to != "" && !resourceID.MatchString(*to) {
		return errors.New("--to is not a valid ID")
	}
	name := *named
	if name == "" {
		if _, name, err = localConfig(*file); err != nil {
			return err
		}
	}
	api, err := a.connect()
	if err != nil {
		return err
	}
	current, err := findApplication(ctx, api, path, name)
	if err != nil {
		return err
	}
	if current == nil {
		return fmt.Errorf("no application is named %q here", client.Clean(name))
	}
	base := path + "/applications/" + current.ID
	target := *to
	if target == "" {
		if target, err = rollbackTarget(ctx, api, base); err != nil {
			return err
		}
	}
	var queued queuedDeployment
	if err := api.Do(ctx, "POST", base+"/deployments/"+target+"/rollback", nil, &queued); err != nil {
		return err
	}
	return a.follow(ctx, api, base, queued.Deployment, *noWait, *timeout)
}

// rollbackTarget finds the newest good deployment of another release than the one serving now.
// Deployments come newest first, so the first success is what serves.
func rollbackTarget(ctx context.Context, api *client.Client, base string) (string, error) {
	var answer struct {
		Items []deployment `json:"items"`
	}
	if err := api.Do(ctx, "GET", base+"/deployments", nil, &answer); err != nil {
		return "", err
	}
	serving := ""
	for _, item := range answer.Items {
		if serving == "" {
			if item.State == "succeeded" {
				serving = item.ReleaseID
			}
			continue
		}
		if (item.State == "succeeded" || item.State == "rolled_back") && item.ReleaseID != serving {
			if !resourceID.MatchString(item.ID) {
				return "", errors.New("the control plane sent an invalid deployment ID")
			}
			return item.ID, nil
		}
	}
	return "", errors.New("there is no earlier good deployment to return to")
}

// follow reports state changes until the deployment ends, and fails unless it succeeded. Stopping
// to follow never stops the deployment itself.
func (a *App) follow(
	ctx context.Context,
	api *client.Client,
	base string,
	started deployment,
	noWait bool,
	timeout time.Duration,
) error {
	if !resourceID.MatchString(started.ID) {
		return errors.New("the control plane sent an invalid deployment ID")
	}
	_, _ = fmt.Fprintf(a.Out, "Deployment %s: %s\n", started.ID, client.Clean(started.State))
	if noWait {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	every := a.PollEvery
	if every <= 0 {
		every = defaultPollEvery
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	last := started
	for !finished(last.State) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("stopped following deployment %s while %s: it keeps running on the server",
				started.ID, client.Clean(last.State))
		case <-ticker.C:
		}
		var next deployment
		if err := api.Do(ctx, "GET", base+"/deployments/"+started.ID, nil, &next); err != nil {
			if ctx.Err() != nil {
				continue // The loop reports why following stopped.
			}
			return err
		}
		if next.State != last.State {
			_, _ = fmt.Fprintf(a.Out, "Deployment %s: %s\n", started.ID, client.Clean(next.State))
		}
		last = next
	}
	if last.State == "succeeded" {
		return nil
	}
	if last.Error != nil && *last.Error != "" {
		return fmt.Errorf("the deployment ended as %s: %s", client.Clean(last.State), client.Clean(*last.Error))
	}
	return fmt.Errorf("the deployment ended as %s", client.Clean(last.State))
}

func finished(state string) bool {
	switch state {
	case "succeeded", "failed", "cancelled", "rolled_back":
		return true
	default:
		return false
	}
}

// server handles the fleet commands a token can reach; adding a server needs a browser session.
func (a *App) server(ctx context.Context, args []string) error {
	if len(args) < 2 || args[0] != "remove" {
		_, _ = fmt.Fprintln(a.Err, "Usage: shipkeep server remove SERVER_ID --confirm NAME --org ORGANIZATION_ID")
		return errUsage
	}
	id := args[1]
	if !resourceID.MatchString(id) {
		return errors.New("the server ID is not valid")
	}
	set := a.flags("server remove")
	confirm := set.String("confirm", "", "the server's exact name; removal cannot be undone")
	organization := set.String("org", a.Getenv("SHIPKEEP_ORG"), "organization ID")
	if err := parse(set, args[2:]); err != nil {
		return err
	}
	if *confirm == "" {
		return errors.New("--confirm is required: give the server's exact name")
	}
	if !resourceID.MatchString(*organization) {
		return errors.New("--org is not a valid ID")
	}
	api, err := a.connect()
	if err != nil {
		return err
	}
	base := "/api/v1/organizations/" + *organization
	var issued struct {
		Token string `json:"token"`
	}
	request := map[string]string{"action": "node.remove", "target": id, "name": *confirm}
	if err := api.Do(ctx, "POST", base+"/confirmations", request, &issued); err != nil {
		return err
	}
	removal := map[string]string{"confirmation": issued.Token}
	if err := api.Do(ctx, "POST", base+"/nodes/"+id+"/remove", removal, nil); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(a.Out, "Server %s removed.\n", client.Clean(*confirm))
	return nil
}
