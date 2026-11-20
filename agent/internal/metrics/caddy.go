package metrics

import (
	"bytes"
	"errors"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Bounds of what the report carries and of what the parser reads.
const (
	MaxContainers = 256
	MaxHosts      = 64
	maxLine       = 4096
)

const (
	durationCount = "caddy_http_request_duration_seconds_count"
	durationSum   = "caddy_http_request_duration_seconds_sum"
)

var hostname = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)

// hostTotals reads, from Caddy's metrics in the Prometheus text format, the responses of each host
// name by status class and the sum of their durations. It reads only the two series it needs and
// skips any line it cannot read: Caddy writes this text, but the agent trusts no input it parses.
// It keeps at most MaxHosts names, the first in alphabetical order.
func hostTotals(text []byte) []*agentv1.HostMetrics {
	byHost := map[string]*agentv1.HostMetrics{}
	for _, raw := range bytes.Split(text, []byte("\n")) {
		// A line longer than any Caddy writes is skipped, and the lines after it still count.
		if len(raw) > maxLine {
			continue
		}
		name, rest, found := strings.Cut(string(raw), "{")
		if !found || (name != durationCount && name != durationSum) {
			continue
		}
		labels, value, ok := parseSample(rest)
		if !ok {
			continue
		}
		host := labels["host"]
		code := labels["code"]
		if !hostname.MatchString(host) {
			continue
		}
		totals := byHost[host]
		if totals == nil {
			totals = &agentv1.HostMetrics{Host: host}
			byHost[host] = totals
		}
		if name == durationSum {
			totals.DurationSeconds += value
			continue
		}
		count := uint64(value)
		switch {
		case len(code) == 3 && code[0] == '2':
			totals.Responses_2Xx += count
		case len(code) == 3 && code[0] == '3':
			totals.Responses_3Xx += count
		case len(code) == 3 && code[0] == '4':
			totals.Responses_4Xx += count
		case len(code) == 3 && code[0] == '5':
			totals.Responses_5Xx += count
		default:
			totals.ResponsesOther += count
		}
	}
	hosts := make([]*agentv1.HostMetrics, 0, len(byHost))
	for _, totals := range byHost {
		hosts = append(hosts, totals)
	}
	slices.SortFunc(hosts, func(a, b *agentv1.HostMetrics) int { return strings.Compare(a.GetHost(), b.GetHost()) })
	if len(hosts) > MaxHosts {
		hosts = hosts[:MaxHosts]
	}
	return hosts
}

var errSample = errors.New("unreadable sample")

// parseSample reads `label="value",...} number [timestamp]`, the rest of a sample line after its
// opening brace. Label values may hold escaped backslashes, quotes and newlines.
func parseSample(rest string) (map[string]string, float64, bool) {
	labels := map[string]string{}
	i := 0
	for {
		if i < len(rest) && rest[i] == '}' {
			i++
			break
		}
		key, value, next, err := parseLabel(rest, i)
		if err != nil {
			return nil, 0, false
		}
		labels[key] = value
		i = next
		if i < len(rest) && rest[i] == ',' {
			i++
		}
	}
	fields := strings.Fields(rest[i:])
	if len(fields) == 0 || len(fields) > 2 {
		return nil, 0, false
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1e15 {
		return nil, 0, false
	}
	return labels, value, true
}

func parseLabel(rest string, i int) (string, string, int, error) {
	start := i
	for i < len(rest) && (rest[i] == '_' || rest[i] >= 'a' && rest[i] <= 'z' || rest[i] >= 'A' && rest[i] <= 'Z' || i > start && rest[i] >= '0' && rest[i] <= '9') {
		i++
	}
	if i == start || i+1 >= len(rest) || rest[i] != '=' || rest[i+1] != '"' {
		return "", "", 0, errSample
	}
	key := rest[start:i]
	i += 2
	var value strings.Builder
	for i < len(rest) {
		switch c := rest[i]; c {
		case '"':
			return key, value.String(), i + 1, nil
		case '\\':
			if i+1 >= len(rest) {
				return "", "", 0, errSample
			}
			switch rest[i+1] {
			case '\\', '"':
				value.WriteByte(rest[i+1])
			case 'n':
				value.WriteByte('\n')
			default:
				return "", "", 0, errSample
			}
			i += 2
		default:
			value.WriteByte(c)
			i++
		}
	}
	return "", "", 0, errSample
}
