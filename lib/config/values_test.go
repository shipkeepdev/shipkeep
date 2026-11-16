package config_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/shipkeepdev/shipkeep/lib/config"
)

const valueDocument = "version: 1\nname: api\nbuild:\n  type: dockerfile\nrun:\n  port: 3000\n"

// The paths and messages are the ones packages/config-schema reports (values.spec.ts): a CLI
// user and an API user read the same explanation.
func TestValuesTheControlPlaneCouldNeverDeploy(t *testing.T) {
	t.Parallel()
	endless := strings.Repeat("9", 29) + "h"
	tests := map[string]struct {
		extra string
		want  []config.Issue
	}{
		"cpu above the agent limit":  {"resources:\n  cpu: '256.001'\n", []config.Issue{{Path: "/resources/cpu", Message: "must be at most 256 CPUs"}}},
		"cpu in millicores above it": {"resources:\n  cpu: 256001m\n", []config.Issue{{Path: "/resources/cpu", Message: "must be at most 256 CPUs"}}},
		"cpu that overflows":         {"resources:\n  cpu: '9999999999999999'\n", []config.Issue{{Path: "/resources/cpu", Message: "must be at most 256 CPUs"}}},
		"memory one byte too small":  {"resources:\n  memory: '6291455'\n", []config.Issue{{Path: "/resources/memory", Message: "must be between 6Mi and 1Ti"}}},
		"memory in decimal units":    {"resources:\n  memory: 6M\n", []config.Issue{{Path: "/resources/memory", Message: "must be between 6Mi and 1Ti"}}},
		"memory that overflows":      {"resources:\n  memory: " + strings.Repeat("9", 30) + "Ti\n", []config.Issue{{Path: "/resources/memory", Message: "must be between 6Mi and 1Ti"}}},
		"both limits": {"resources:\n  cpu: '257'\n  memory: 2Ti\n", []config.Issue{
			{Path: "/resources/cpu", Message: "must be at most 256 CPUs"},
			{Path: "/resources/memory", Message: "must be between 6Mi and 1Ti"},
		}},
		"every duration the pipeline reads": {
			"release:\n  command: [migrate]\n  timeout: " + endless + "\ndeploy:\n  drain_timeout: " + endless + "\n",
			[]config.Issue{
				{Path: "/release/timeout", Message: "is too long to be counted"},
				{Path: "/deploy/drain_timeout", Message: "is too long to be counted"},
			},
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load([]byte(valueDocument + test.extra))
			var verr *config.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Load() error = %v, want *ValidationError", err)
			}
			if !reflect.DeepEqual(verr.Issues, test.want) {
				t.Fatalf("issues = %v, want %v", verr.Issues, test.want)
			}
		})
	}
	for name, extra := range map[string]string{
		"no resources":     "",
		"smallest limits":  "resources:\n  cpu: 1m\n  memory: '6291456'\n",
		"largest limits":   "resources:\n  cpu: 256000m\n  memory: 1Ti\n",
		"a month of drain": "deploy:\n  drain_timeout: 720h\n",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := config.Load([]byte(valueDocument + extra)); err != nil {
				t.Fatalf("Load() error = %v", err)
			}
		})
	}
}
