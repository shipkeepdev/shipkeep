package config

import (
	"math"
	"regexp"
	"strconv"
)

// What the control plane can deploy (SPEC 2.2). The agent refuses a container above 256 CPUs or
// 1 TiB, and Docker refuses a memory limit below 6 MiB. A disk budget is between 64 MiB and 1 TiB
// (ADR 0022). packages/config-schema holds the same
// numbers for the TypeScript validator; the shared fixtures keep the two in step.
const (
	maxCPUMillis   = 256_000
	minMemoryBytes = 6 << 20
	maxMemoryBytes = 1 << 40
	minDiskBytes   = 64 << 20
	maxDiskBytes   = 1 << 40
	// maxCountable is the largest whole number of milliseconds the control plane counts exactly
	// (JavaScript's Number.MAX_SAFE_INTEGER).
	maxCountable = 1<<53 - 1
)

var (
	cpuMillisPattern = regexp.MustCompile(`^([0-9]+)m$`)
	cpuCoresPattern  = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
	sizePattern      = regexp.MustCompile(`^([0-9]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$`)
	durationPattern  = regexp.MustCompile(`^([0-9]+(ms|s|m|h))+$`)
	durationPart     = regexp.MustCompile(`([0-9]+)(ms|s|m|h)`)
	sizeUnits        = map[string]float64{
		"": 1, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
		"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40,
	}
	durationUnits = map[string]float64{"ms": 1, "s": 1e3, "m": 6e4, "h": 3.6e6}
)

// The readers below use float64 on purpose: the control plane reads the same text with
// JavaScript numbers, and both sides must refuse exactly the same documents.

// cpuMillicores reads "0.5" or "500m" as millicores; NaN when it is not a CPU amount.
func cpuMillicores(text string) float64 {
	if match := cpuMillisPattern.FindStringSubmatch(text); match != nil {
		return number(match[1])
	}
	if cpuCoresPattern.MatchString(text) {
		return number(text) * 1000
	}
	return math.NaN()
}

// sizeInBytes reads a Kubernetes-style size ("512Mi", "2G", bare bytes); NaN when it is not one.
func sizeInBytes(text string) float64 {
	match := sizePattern.FindStringSubmatch(text)
	if match == nil {
		return math.NaN()
	}
	return number(match[1]) * sizeUnits[match[2]]
}

// durationInMs reads a Go-style duration ("30s", "1m30s", "500ms"); NaN when it is not one.
func durationInMs(text string) float64 {
	if !durationPattern.MatchString(text) {
		return math.NaN()
	}
	total := 0.0
	for _, part := range durationPart.FindAllStringSubmatch(text, -1) {
		total += number(part[1]) * durationUnits[part[2]]
	}
	return total
}

func number(digits string) float64 {
	value, err := strconv.ParseFloat(digits, 64)
	if err != nil {
		return math.Inf(1)
	}
	return value
}

// valueIssues reports what the schema cannot express: values that are well formed and that the
// control plane could never deploy. It runs on a document the schema already accepted.
func valueIssues(document any) []Issue {
	var issues []Issue
	if cpu, ok := text(document, "resources", "cpu"); ok {
		if millis := cpuMillicores(cpu); !(millis > 0 && millis <= maxCPUMillis) {
			issues = append(issues, Issue{Path: "/resources/cpu", Message: "must be at most 256 CPUs"})
		}
	}
	if memory, ok := text(document, "resources", "memory"); ok {
		if bytes := sizeInBytes(memory); !(bytes >= minMemoryBytes && bytes <= maxMemoryBytes) {
			issues = append(issues, Issue{Path: "/resources/memory", Message: "must be between 6Mi and 1Ti"})
		}
	}
	if disk, ok := text(document, "resources", "disk"); ok {
		if bytes := sizeInBytes(disk); !(bytes >= minDiskBytes && bytes <= maxDiskBytes) {
			issues = append(issues, Issue{Path: "/resources/disk", Message: "must be between 64Mi and 1Ti"})
		}
	}
	// Every duration the deployment pipeline reads. A value it cannot count would fail there.
	for _, path := range [][]string{
		{"run", "healthcheck", "interval"},
		{"run", "healthcheck", "timeout"},
		{"run", "healthcheck", "start_period"},
		{"release", "timeout"},
		{"deploy", "drain_timeout"},
	} {
		value, ok := text(document, path...)
		if !ok {
			continue
		}
		if ms := durationInMs(value); !(ms <= maxCountable && ms == math.Trunc(ms)) {
			pointer := ""
			for _, key := range path {
				pointer += "/" + key
			}
			issues = append(issues, Issue{Path: pointer, Message: "is too long to be counted"})
		}
	}
	return issues
}

// text follows keys through nested maps and returns the string found there, if any.
func text(document any, keys ...string) (string, bool) {
	current := document
	for _, key := range keys {
		object, ok := current.(map[string]any)
		if !ok {
			return "", false
		}
		if current, ok = object[key]; !ok {
			return "", false
		}
	}
	value, ok := current.(string)
	return value, ok
}
