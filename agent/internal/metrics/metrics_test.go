package metrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
)

// Lines as Caddy 2.11.9 wrote them with per_host enabled (ADR 0024), with the series the sampler
// does not read around them.
const caddyText = `# HELP caddy_http_request_duration_seconds Histogram of round-trip request durations.
# TYPE caddy_http_request_duration_seconds histogram
caddy_http_request_duration_seconds_bucket{code="200",handler="reverse_proxy",host="shop.example.com",method="GET",server="shipkeep",le="0.005"} 3
caddy_http_request_duration_seconds_sum{code="200",handler="reverse_proxy",host="shop.example.com",method="GET",server="shipkeep"} 0.25
caddy_http_request_duration_seconds_count{code="200",handler="reverse_proxy",host="shop.example.com",method="GET",server="shipkeep"} 40
caddy_http_request_duration_seconds_sum{code="200",handler="reverse_proxy",host="shop.example.com",method="POST",server="shipkeep"} 0.5
caddy_http_request_duration_seconds_count{code="200",handler="reverse_proxy",host="shop.example.com",method="POST",server="shipkeep"} 2
caddy_http_request_duration_seconds_sum{code="502",handler="reverse_proxy",host="shop.example.com",method="GET",server="shipkeep"} 1.5
caddy_http_request_duration_seconds_count{code="502",handler="reverse_proxy",host="shop.example.com",method="GET",server="shipkeep"} 3
caddy_http_request_duration_seconds_count{code="404",handler="static_response",host="api.example.com",method="GET",server="shipkeep"} 1e+06
caddy_http_request_duration_seconds_count{code="301",handler="static_response",host="api.example.com",method="GET",server="shipkeep"} 7
caddy_http_request_duration_seconds_count{code="101",handler="reverse_proxy",host="api.example.com",method="GET",server="shipkeep"} 2
caddy_http_requests_total{handler="reverse_proxy",host="shop.example.com",server="shipkeep"} 45
`

func TestReadsCaddyRequestsByHostAndStatusClass(t *testing.T) {
	hosts := hostTotals([]byte(caddyText))
	if len(hosts) != 2 {
		t.Fatalf("hosts = %v", hosts)
	}
	api, shop := hosts[0], hosts[1]
	if api.GetHost() != "api.example.com" || api.GetResponses_4Xx() != 1_000_000 || api.GetResponses_3Xx() != 7 || api.GetResponsesOther() != 2 {
		t.Fatalf("api = %v", api)
	}
	if shop.GetResponses_2Xx() != 42 || shop.GetResponses_5Xx() != 3 || shop.GetDurationSeconds() != 2.25 {
		t.Fatalf("shop = %v", shop)
	}
}

// The parser trusts nothing it reads: a line it cannot read is skipped, never half-read, and the
// lines after it still count.
func TestSkipsCaddyLinesItCannotRead(t *testing.T) {
	good := `caddy_http_request_duration_seconds_count{code="200",host="ok.example.com"} 5`
	for name, line := range map[string]string{
		"an unterminated value": `caddy_http_request_duration_seconds_count{code="200",host="a.example.com} 5`,
		"an unknown escape":     `caddy_http_request_duration_seconds_count{code="200",host="a\x.example.com"} 5`,
		"an uppercase host":     `caddy_http_request_duration_seconds_count{code="200",host="A.example.com"} 5`,
		"an injected host":      `caddy_http_request_duration_seconds_count{code="200",host="a.example.com\"} 9\n"} 5`,
		"a path host":           `caddy_http_request_duration_seconds_count{code="200",host="../etc/passwd"} 5`,
		"no host":               `caddy_http_request_duration_seconds_count{code="200"} 5`,
		"a negative count":      `caddy_http_request_duration_seconds_count{code="200",host="a.example.com"} -5`,
		"not a number":          `caddy_http_request_duration_seconds_count{code="200",host="a.example.com"} NaN`,
		"an infinite count":     `caddy_http_request_duration_seconds_count{code="200",host="a.example.com"} +Inf`,
		"an absurd count":       `caddy_http_request_duration_seconds_count{code="200",host="a.example.com"} 1e300`,
		"three fields":          `caddy_http_request_duration_seconds_count{code="200",host="a.example.com"} 5 1 2`,
		"a long line":           `caddy_http_request_duration_seconds_count{code="200",host="a.example.com",x="` + strings.Repeat("x", 5000) + `"} 5`,
		"a bad label name":      `caddy_http_request_duration_seconds_count{1code="200",host="a.example.com"} 5`,
		"caddy's catch-all":     `caddy_http_request_duration_seconds_count{code="200",host="_other"} 5`,
	} {
		hosts := hostTotals([]byte(line + "\n" + good + "\n"))
		if len(hosts) != 1 || hosts[0].GetHost() != "ok.example.com" || hosts[0].GetResponses_2Xx() != 5 {
			t.Fatalf("%s: hosts = %v", name, hosts)
		}
	}
}

// Caddy labels a request by its Host header, which may carry a port for the same route: both forms
// count under the host name. A port that is not one leaves the label to the host name check.
func TestCountsAHostWithItsPortUnderItsName(t *testing.T) {
	text := `caddy_http_request_duration_seconds_count{code="200",host="shop.example.com"} 5
caddy_http_request_duration_seconds_count{code="200",host="shop.example.com:443"} 2
caddy_http_request_duration_seconds_sum{code="200",host="shop.example.com:443"} 0.5
caddy_http_request_duration_seconds_count{code="200",host="shop.example.com:x1"} 9
caddy_http_request_duration_seconds_count{code="200",host="shop.example.com:4430000"} 9
caddy_http_request_duration_seconds_count{code="200",host="shop.example.com:"} 9
caddy_http_request_duration_seconds_count{code="200",host=":443"} 9
caddy_http_request_duration_seconds_count{code="200",host="a:1:2"} 9
`
	hosts := hostTotals([]byte(text))
	if len(hosts) != 1 || hosts[0].GetHost() != "shop.example.com" || hosts[0].GetResponses_2Xx() != 7 || hosts[0].GetDurationSeconds() != 0.5 {
		t.Fatalf("hosts = %v", hosts)
	}
}

func TestReadsEveryHostSortedByName(t *testing.T) {
	var text strings.Builder
	for i := range MaxHosts + 10 {
		fmt.Fprintf(&text, "caddy_http_request_duration_seconds_count{code=\"200\",host=\"h%03d.example.com\"} 1\n", MaxHosts+9-i)
	}
	hosts := hostTotals([]byte(text.String()))
	if len(hosts) != MaxHosts+10 || hosts[0].GetHost() != "h000.example.com" {
		t.Fatalf("%d hosts, first %s", len(hosts), hosts[0].GetHost())
	}
}

// Past the bound, each sample takes the next items: every one is reported within a few samples,
// none is left out for good.
func TestRotatesThroughItemsPastTheBound(t *testing.T) {
	items := make([]int, 10)
	for i := range items {
		items[i] = i
	}
	offset := 0
	seen := map[int]int{}
	for range 3 {
		picked := rotate(items, 4, &offset)
		if len(picked) != 4 {
			t.Fatalf("picked %v", picked)
		}
		for _, item := range picked {
			seen[item]++
		}
	}
	if len(seen) != 10 {
		t.Fatalf("after ceil(10/4) samples, seen %v", seen)
	}
	if got := rotate(items[:3], 4, &offset); len(got) != 3 || offset != 0 {
		t.Fatalf("a list within the bound: %v, offset %d", got, offset)
	}
}

// A proc tree with the lines the kernel writes.
func proc(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o750); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{
		"stat":    "cpu  1000 50 300 9000 200 10 40 5 0 0\ncpu0 500 25 150 4500 100 5 20 2 0 0\ncpu1 500 25 150 4500 100 5 20 3 0 0\nintr 12345\n",
		"meminfo": "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    6384000 kB\nHugePages_Total:       0\n",
		"net/dev": "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\ndocker0: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0\nveth1a2b: 7 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n  ens5: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\nshipkeep0: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\n   br0: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0\ntunnel0: 800 1 0 0 0 0 0 0 800 1 0 0 0 0 0 0\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// A sys tree where br0 is a bridge and tunnel0 has no link layer (WireGuard), whatever their names.
func sys(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for name, kind := range map[string]string{"eth0": "1", "ens5": "1", "br0": "1", "tunnel0": "65534"} {
		dir := filepath.Join(root, "class", "net", name)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "type"), []byte(kind+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "class", "net", "br0", "bridge"), 0o750); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestReadsTheNodeFromProc(t *testing.T) {
	node, err := readNode(proc(t), sys(t))
	if err != nil {
		t.Fatal(err)
	}
	// user + nice + system + irq + softirq + steal, in hundredths of a second.
	if node.GetCpuSeconds() != 14.05 || node.GetCpuCores() != 2 {
		t.Fatalf("cpu = %v s on %d cores", node.GetCpuSeconds(), node.GetCpuCores())
	}
	if node.GetMemoryTotalBytes() != 16384000*1024 || node.GetMemoryUsedBytes() != 10000000*1024 {
		t.Fatalf("memory = %d of %d", node.GetMemoryUsedBytes(), node.GetMemoryTotalBytes())
	}
	if node.GetNetworkReceivedBytes() != 1300 || node.GetNetworkSentBytes() != 2400 {
		t.Fatalf("traffic = %d in, %d out: only physical interfaces count", node.GetNetworkReceivedBytes(), node.GetNetworkSentBytes())
	}
	// Without sys, interfaces are told apart by name only: br0 and tunnel0 then count.
	byName, err := readNode(proc(t), "")
	if err != nil || byName.GetNetworkReceivedBytes() != 3000 {
		t.Fatalf("traffic by name = %d, err %v", byName.GetNetworkReceivedBytes(), err)
	}
	for _, name := range []string{"", ".", "..", "../../etc", "eth0/../br0"} {
		if virtualByKind(sys(t), name) {
			t.Fatalf("%q read outside sys/class/net", name)
		}
	}
}

func TestRefusesAProcItCannotRead(t *testing.T) {
	for name, stat := range map[string]string{
		"no cpu line":    "cpu0 1 2 3 4 5 6 7 8\n",
		"a short line":   "cpu  1 2 3\ncpu0 1 2 3 4 5 6 7 8\n",
		"not a number":   "cpu  1 x 3 4 5 6 7 8\ncpu0 1 2 3 4 5 6 7 8\n",
		"no core at all": "cpu  1 2 3 4 5 6 7 8\n",
	} {
		if _, _, err := cpu([]byte(stat)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	if _, _, err := memory([]byte("MemTotal: 100 kB\nMemAvailable: 200 kB\n")); err == nil {
		t.Fatal("more memory available than in total was accepted")
	}
}

type fakeEngine struct {
	summaries []docker.ContainerSummary
	stats     map[string]docker.ContainerStats
	listErr   error
	rootErr   error
}

func (f *fakeEngine) ManagedContainers(context.Context) ([]docker.ContainerSummary, error) {
	return f.summaries, f.listErr
}
func (f *fakeEngine) ContainerStats(_ context.Context, id string) (docker.ContainerStats, error) {
	stats, ok := f.stats[id]
	if !ok {
		return docker.ContainerStats{}, errors.New("no such container")
	}
	return stats, nil
}
func (f *fakeEngine) DataRoot(context.Context) (string, error) { return os.TempDir(), f.rootErr }

type fakeCaddy struct {
	text    string
	err     error
	enabled int
	// unsafe says per-host metrics stay off, as for a route without the Host bound.
	unsafe bool
}

func (f *fakeCaddy) EnableRequestMetrics(context.Context) (bool, error) {
	f.enabled++
	return !f.unsafe, f.err
}
func (f *fakeCaddy) RequestMetrics(context.Context) ([]byte, error) { return []byte(f.text), f.err }

func stats(cpuNanos, usage, inactive, limit uint64) docker.ContainerStats {
	var s docker.ContainerStats
	s.CPU.Usage.Total = cpuNanos
	s.Memory.Usage, s.Memory.Limit = usage, limit
	s.Memory.Stats = map[string]uint64{"inactive_file": inactive}
	s.Networks = map[string]struct {
		Received uint64 `json:"rx_bytes"`
		Sent     uint64 `json:"tx_bytes"`
	}{"eth0": {Received: 100, Sent: 50}, "eth1": {Received: 10, Sent: 5}}
	return s
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSamplesRunningManagedContainersAndHosts(t *testing.T) {
	engine := &fakeEngine{
		summaries: []docker.ContainerSummary{
			{ID: "1", Names: []string{"/sk-shop-0123456789ab-r1-0"}, State: "running"},
			{ID: "2", Names: []string{"/sk-old-0123456789ab-r1-0"}, State: "exited"},
			{ID: "3", Names: []string{"/not-managed-by-name"}, State: "running"},
			{ID: "4", Names: []string{"/sk-gone-0123456789ab-r1-0"}, State: "running"},
		},
		stats: map[string]docker.ContainerStats{"1": stats(2_500_000_000, 300, 100, 512)},
	}
	caddy := &fakeCaddy{text: caddyText}
	at := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	sampler := &Sampler{Containers: engine, Requests: caddy, Proc: proc(t), Logger: quiet(), Now: func() time.Time { return at }}
	report, err := sampler.Sample(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.GetContainers()) != 1 {
		t.Fatalf("containers = %v", report.GetContainers())
	}
	shop := report.GetContainers()[0]
	if shop.GetName() != "sk-shop-0123456789ab-r1-0" || shop.GetCpuSeconds() != 2.5 || shop.GetMemoryUsedBytes() != 200 || shop.GetMemoryLimitBytes() != 512 || shop.GetNetworkReceivedBytes() != 110 || shop.GetNetworkSentBytes() != 55 {
		t.Fatalf("shop = %v", shop)
	}
	if len(report.GetHosts()) != 2 || caddy.enabled != 1 || report.GetNode().GetCpuCores() != 2 || !report.GetSampledAt().AsTime().Equal(at) {
		t.Fatalf("report = %v", report)
	}
	if report.GetNode().GetDiskTotalBytes() == 0 {
		t.Fatal("no disk size")
	}
}

// While a route lets clients choose the host label, per-host metrics are off and no host is read,
// without failing the rest of the sample.
func TestReportsNoHostWhilePerHostMetricsAreOff(t *testing.T) {
	sampler := &Sampler{Containers: &fakeEngine{}, Requests: &fakeCaddy{text: caddyText, unsafe: true}, Proc: proc(t), Logger: quiet()}
	report, err := sampler.Sample(t.Context())
	if err != nil || len(report.GetHosts()) != 0 || report.GetNode() == nil {
		t.Fatalf("report = %v, err = %v", report, err)
	}
}

// Memory in use leaves out the page cache under its cgroup v1 or v2 name, as `docker stats` does.
func TestMemoryInUseLeavesOutThePageCache(t *testing.T) {
	for name, c := range map[string]struct {
		cache map[string]uint64
		want  uint64
	}{
		"cgroup v2":                  {map[string]uint64{"inactive_file": 20}, 280},
		"cgroup v1":                  {map[string]uint64{"inactive_file": 20, "total_inactive_file": 100}, 200},
		"a v1 cache above the usage": {map[string]uint64{"inactive_file": 20, "total_inactive_file": 900}, 280},
		"a v2 cache above the usage": {map[string]uint64{"inactive_file": 900}, 300},
		"no cache counter":           {nil, 300},
	} {
		var s docker.ContainerStats
		s.Memory.Usage, s.Memory.Stats = 300, c.cache
		if got := s.MemoryInUse(); got != c.want {
			t.Fatalf("%s: %d, want %d", name, got, c.want)
		}
	}
}

// One part that fails leaves the others in the report; when all fail, there is no report.
func TestSendsWhatItCouldSample(t *testing.T) {
	engine := &fakeEngine{listErr: errors.New("docker down")}
	sampler := &Sampler{Containers: engine, Requests: &fakeCaddy{text: caddyText}, Proc: proc(t), Logger: quiet()}
	report, err := sampler.Sample(t.Context())
	if err != nil || report.GetContainers() != nil || report.GetNode() == nil || len(report.GetHosts()) != 2 {
		t.Fatalf("report = %v, err = %v", report, err)
	}
	// Containers run but none of their stats can be read: that part failed, it is not empty.
	unreadable := &Sampler{Containers: &fakeEngine{summaries: []docker.ContainerSummary{{ID: "1", Names: []string{"/sk-shop-0123456789ab-r1-0"}, State: "running"}}}, Requests: &fakeCaddy{err: errors.New("down")}, Proc: filepath.Join(t.TempDir(), "missing"), Logger: quiet()}
	if report, err := unreadable.Sample(t.Context()); err == nil || report != nil {
		t.Fatalf("a sample with no stats was reported: %v", report)
	}
	failing := &Sampler{Containers: &fakeEngine{listErr: errors.New("down"), rootErr: errors.New("down")}, Requests: &fakeCaddy{err: errors.New("down")}, Proc: filepath.Join(t.TempDir(), "missing"), Logger: quiet()}
	if report, err := failing.Sample(t.Context()); err == nil || report != nil {
		t.Fatalf("an empty sample was reported: %v", report)
	}
}

func TestKeepsAtMostMaxContainersAndRotates(t *testing.T) {
	engine := &fakeEngine{stats: map[string]docker.ContainerStats{}}
	for i := range MaxContainers + 20 {
		id := fmt.Sprint(i)
		engine.summaries = append(engine.summaries, docker.ContainerSummary{ID: id, Names: []string{fmt.Sprintf("/sk-app-%04d", i)}, State: "running"})
		engine.stats[id] = stats(1, 1, 0, 1)
	}
	sampler := &Sampler{Containers: engine, Proc: proc(t), Logger: quiet()}
	first, err := sampler.Sample(t.Context())
	if err != nil || len(first.GetContainers()) != MaxContainers || first.GetContainers()[0].GetName() != "sk-app-0000" {
		t.Fatalf("%d containers, err %v", len(first.GetContainers()), err)
	}
	second, err := sampler.Sample(t.Context())
	if err != nil || len(second.GetContainers()) != MaxContainers || second.GetContainers()[0].GetName() != fmt.Sprintf("sk-app-%04d", MaxContainers) {
		t.Fatalf("the second sample did not start past the first: %s", second.GetContainers()[0].GetName())
	}
}
