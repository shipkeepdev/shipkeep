// Package commands implements the shipkeep command line.
package commands

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/shipkeepdev/shipkeep/cli/internal/client"
	"github.com/shipkeepdev/shipkeep/cli/internal/credentials"
	"github.com/shipkeepdev/shipkeep/lib/config"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const usage = `Usage: shipkeep <command> [flags]

  login            Save a control plane address and an API token
  logout           Forget them on this machine
  init             Write a shipkeep.yml
  status           Show applications, their latest deployment and replicas
  secrets list     Show the names of an environment's secrets
  secrets set      Set a secret, reading its value from standard input
  secrets unset    Remove a secret
  deploy           Save shipkeep.yml on the control plane and deploy it
  rollback         Return to an earlier good release
  server remove    Remove a server, given its exact name with --confirm

Commands that reach an environment take --org, --project and --env, or
SHIPKEEP_ORG, SHIPKEEP_PROJECT and SHIPKEEP_ENV. SHIPKEEP_URL and SHIPKEEP_TOKEN
replace the saved login, for automation.
`

// App holds what a command touches outside itself, so that tests can replace it.
type App struct {
	In     io.Reader
	Out    io.Writer
	Err    io.Writer
	Getenv func(string) string
	// CredentialsPath returns where login stores its file.
	CredentialsPath func() (string, error)
	// ReadSecret reads one secret value: without echo on a terminal, otherwise all of In.
	ReadSecret func(prompt string) (string, error)
	// PollEvery is how often a deployment is checked; zero means the default.
	PollEvery time.Duration
}

// New returns an App bound to the process's own streams and environment.
func New(in *os.File, out, errOut io.Writer) *App {
	app := &App{
		In:              in,
		Out:             out,
		Err:             errOut,
		Getenv:          os.Getenv,
		CredentialsPath: credentials.Path,
	}
	app.ReadSecret = func(prompt string) (string, error) {
		// #nosec G115 -- a file descriptor fits an int.
		descriptor := int(in.Fd())
		if !term.IsTerminal(descriptor) {
			return readAll(in)
		}
		_, _ = fmt.Fprint(errOut, prompt)
		value, err := term.ReadPassword(descriptor)
		_, _ = fmt.Fprintln(errOut)
		if err != nil {
			return "", errors.New("the value could not be read")
		}
		return string(value), nil
	}
	return app
}

const maxSecretBytes = 65536

// readAll reads a piped value, dropping the newline a shell or a file usually ends it with.
func readAll(in io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(in, maxSecretBytes+2))
	if err != nil {
		return "", errors.New("the value could not be read")
	}
	value := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
	if len(value) > maxSecretBytes {
		return "", fmt.Errorf("the value is larger than %d bytes", maxSecretBytes)
	}
	return value, nil
}

// errUsage marks a mistake in the command line itself, which exits with 2.
var errUsage = errors.New("usage")

// Run executes one command line and returns the process exit code.
func (a *App) Run(ctx context.Context, args []string) int {
	err := a.dispatch(ctx, args)
	switch {
	case err == nil:
		return 0
	case errors.Is(err, errUsage), errors.Is(err, flag.ErrHelp):
		return 2
	default:
		_, _ = fmt.Fprintf(a.Err, "shipkeep: %v\n", err)
		return 1
	}
}

func (a *App) dispatch(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return a.showUsage()
	}
	command, rest := args[0], args[1:]
	switch command {
	case "login":
		return a.login(ctx, rest)
	case "logout":
		return a.logout(rest)
	case "init":
		return a.init(rest)
	case "status":
		return a.status(ctx, rest)
	case "secrets":
		return a.secrets(ctx, rest)
	case "deploy":
		return a.deploy(ctx, rest)
	case "rollback":
		return a.rollback(ctx, rest)
	case "server":
		return a.server(ctx, rest)
	default:
		_, _ = fmt.Fprintf(a.Err, "shipkeep: unknown command %q\n", client.Clean(command))
		return a.showUsage()
	}
}

func (a *App) showUsage() error {
	_, _ = fmt.Fprint(a.Err, usage)
	return errUsage
}

func (a *App) flags(name string) *flag.FlagSet {
	set := flag.NewFlagSet("shipkeep "+name, flag.ContinueOnError)
	set.SetOutput(a.Err)
	return set
}

// parse also refuses leftovers: a misplaced flag must not be silently ignored.
func parse(set *flag.FlagSet, args []string) error {
	if err := set.Parse(args); err != nil {
		return errors.Join(errUsage, err)
	}
	if set.NArg() > 0 {
		_, _ = fmt.Fprintf(set.Output(), "unexpected argument %q\n", client.Clean(set.Arg(0)))
		return errUsage
	}
	return nil
}

// connect builds a client from the environment, or else from the saved login.
func (a *App) connect() (*client.Client, error) {
	rawURL, token := a.Getenv("SHIPKEEP_URL"), a.Getenv("SHIPKEEP_TOKEN")
	if token == "" {
		path, err := a.CredentialsPath()
		if err != nil {
			return nil, err
		}
		stored, err := credentials.Load(path)
		if err != nil {
			return nil, err
		}
		token = stored.Token.Expose()
		if rawURL == "" {
			rawURL = stored.URL
		}
	}
	if rawURL == "" {
		return nil, errors.New("SHIPKEEP_TOKEN needs SHIPKEEP_URL")
	}
	base, err := client.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	return client.New(base, secret.NewString(token)), nil
}

// Canonical UUIDv7, as the API accepts: these values become URL path segments.
var resourceID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

// target names one environment.
type target struct {
	organization, project, environment *string
}

func (a *App) targetFlags(set *flag.FlagSet) target {
	return target{
		organization: set.String("org", a.Getenv("SHIPKEEP_ORG"), "organization ID"),
		project:      set.String("project", a.Getenv("SHIPKEEP_PROJECT"), "project ID"),
		environment:  set.String("env", a.Getenv("SHIPKEEP_ENV"), "environment ID"),
	}
}

// path returns the environment's API path, refusing anything but canonical IDs.
func (t target) path() (string, error) {
	for _, field := range []struct{ name, value string }{
		{"--org", *t.organization}, {"--project", *t.project}, {"--env", *t.environment},
	} {
		if field.value == "" {
			return "", fmt.Errorf("%s is required", field.name)
		}
		if !resourceID.MatchString(field.value) {
			return "", fmt.Errorf("%s is not a valid ID", field.name)
		}
	}
	return "/api/v1/organizations/" + *t.organization + "/projects/" + *t.project +
		"/environments/" + *t.environment, nil
}

func (a *App) login(ctx context.Context, args []string) error {
	set := a.flags("login")
	address := set.String("url", a.Getenv("SHIPKEEP_URL"), "control plane URL, https://...")
	if err := parse(set, args); err != nil {
		return err
	}
	if *address == "" {
		return errors.New("--url is required")
	}
	base, err := client.ParseURL(*address)
	if err != nil {
		return err
	}
	// Never a flag: a token on a command line lands in shell history and the process list.
	value, err := a.ReadSecret("API token: ")
	if err != nil {
		return err
	}
	if value == "" {
		return errors.New("no token was given")
	}
	token := secret.NewString(value)

	// 403 means the token is valid but holds no profile.read, which a scoped token need not have.
	err = client.New(base, token).Do(ctx, "GET", "/api/v1/auth/session", nil, nil)
	var problem *client.ProblemError
	if err != nil && (!errors.As(err, &problem) || problem.Status != 403) {
		return fmt.Errorf("the token was not saved: %w", err)
	}
	path, err := a.CredentialsPath()
	if err != nil {
		return err
	}
	if err := credentials.Save(path, credentials.Stored{URL: base.String(), Token: token}); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(a.Out, "Logged in to %s.\n", base.String())
	return nil
}

func (a *App) logout(args []string) error {
	if err := parse(a.flags("logout"), args); err != nil {
		return err
	}
	path, err := a.CredentialsPath()
	if err != nil {
		return err
	}
	if err := credentials.Remove(path); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(a.Out, "Logged out. The token itself stays valid until it is revoked or expires.")
	return nil
}

func (a *App) init(args []string) error {
	set := a.flags("init")
	name := set.String("name", "", "application name")
	image := set.String("image", "", "container image")
	port := set.Int("port", 80, "port the application listens on")
	file := set.String("file", "shipkeep.yml", "file to write")
	force := set.Bool("force", false, "replace an existing file")
	if err := parse(set, args); err != nil {
		return err
	}
	if *name == "" || *image == "" {
		return errors.New("--name and --image are required")
	}
	// %q is also valid YAML, so a value can only ever be a string; the schema then judges it.
	document := fmt.Sprintf(
		"version: 1\nname: %q\nbuild:\n  type: image\n  image: %q\nrun:\n  port: %d\n",
		*name, *image, *port)
	if _, err := config.Load([]byte(document)); err != nil {
		return fmt.Errorf("this configuration is not valid: %w", err)
	}
	mode := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if *force {
		mode = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	// #nosec G302 G304 -- a repository file the user names; it holds no secret.
	output, err := os.OpenFile(*file, mode, 0o644)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already exists: use --force to replace it", *file)
	}
	if err != nil {
		return fmt.Errorf("write the configuration: %w", err)
	}
	if _, err := output.WriteString(document); err != nil {
		_ = output.Close()
		return fmt.Errorf("write the configuration: %w", err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("write the configuration: %w", err)
	}
	_, _ = fmt.Fprintf(a.Out, "Wrote %s.\n", *file)
	return nil
}

// secretName is the API's pattern; the name becomes a URL path segment.
var secretName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)

func (a *App) secrets(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return a.showUsage()
	}
	switch args[0] {
	case "list":
		return a.secretsList(ctx, args[1:])
	case "set", "unset":
		if len(args) < 2 {
			_, _ = fmt.Fprintf(a.Err, "shipkeep secrets %s needs a NAME\n", args[0])
			return errUsage
		}
		if !secretName.MatchString(args[1]) {
			return errors.New("a secret name holds uppercase letters, digits and underscores")
		}
		if args[0] == "set" {
			return a.secretSet(ctx, args[1], args[2:])
		}
		return a.secretUnset(ctx, args[1], args[2:])
	default:
		return a.showUsage()
	}
}

func (a *App) secretsList(ctx context.Context, args []string) error {
	set := a.flags("secrets list")
	where := a.targetFlags(set)
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
	var answer struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}
	if err := api.Do(ctx, "GET", path+"/secrets", nil, &answer); err != nil {
		return err
	}
	for _, item := range answer.Items {
		_, _ = fmt.Fprintln(a.Out, client.Clean(item.Name))
	}
	return nil
}

func (a *App) secretSet(ctx context.Context, name string, args []string) error {
	set := a.flags("secrets set")
	where := a.targetFlags(set)
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
	value, err := a.ReadSecret("Value of " + name + ": ")
	if err != nil {
		return err
	}
	if value == "" {
		return errors.New("no value was given")
	}
	if len(value) > maxSecretBytes {
		return fmt.Errorf("the value is larger than %d bytes", maxSecretBytes)
	}
	body := map[string]string{"name": name, "value": value}
	if err := api.Do(ctx, "POST", path+"/secrets", body, nil); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(a.Out, "Secret %s set.\n", name)
	return nil
}

func (a *App) secretUnset(ctx context.Context, name string, args []string) error {
	set := a.flags("secrets unset")
	where := a.targetFlags(set)
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
	if err := api.Do(ctx, "POST", path+"/secrets/"+url.PathEscape(name)+"/remove", nil, nil); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(a.Out, "Secret %s removed.\n", name)
	return nil
}
