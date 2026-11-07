package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shipkeepdev/shipkeep/lib/config"
)

// Golden fixtures are shared with the TypeScript validator (packages/config-schema/fixtures).
const fixturesDir = "../../packages/config-schema/fixtures"

func listFixtures(t *testing.T, kind string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(fixturesDir, kind))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".yml") {
			names = append(names, e.Name())
		}
	}
	return names
}

func readFixture(t *testing.T, kind, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixturesDir, kind, name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}

func TestGoldenFixtureCounts(t *testing.T) {
	t.Parallel()
	if n := len(listFixtures(t, "valid")); n < 20 {
		t.Fatalf("want at least 20 valid fixtures, got %d", n)
	}
	if n := len(listFixtures(t, "invalid")); n < 30 {
		t.Fatalf("want at least 30 invalid fixtures, got %d", n)
	}
}

func TestValidFixtures(t *testing.T) {
	t.Parallel()
	for _, name := range listFixtures(t, "valid") {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			cfg, err := config.Load(readFixture(t, "valid", name))
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.Name == "" {
				t.Fatal("decoded config has an empty name")
			}
		})
	}
}

func TestInvalidFixtures(t *testing.T) {
	t.Parallel()
	for _, name := range listFixtures(t, "invalid") {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(readFixture(t, "invalid", name))
			var verr *config.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Load() error = %v, want *ValidationError", err)
			}
			if len(verr.Issues) == 0 {
				t.Fatal("validation error without issues")
			}
			for _, issue := range verr.Issues {
				if issue.Message == "" {
					t.Fatalf("issue at %q has an empty message", issue.Path)
				}
			}
		})
	}
}

func TestLoadDecodesTypedConfig(t *testing.T) {
	t.Parallel()
	cfg, err := config.Load(readFixture(t, "valid", "full-example.yml"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Name != "billing-api" {
		t.Fatalf("Name = %q", cfg.Name)
	}
	if cfg.Run == nil || cfg.Run.Port != 3000 {
		t.Fatalf("Run.Port = %+v", cfg.Run)
	}
	if cfg.Build == nil || cfg.Build.Type != "dockerfile" {
		t.Fatalf("Build = %+v", cfg.Build)
	}
	if len(cfg.Secrets) != 2 || cfg.Secrets[0] != "DATABASE_URL" {
		t.Fatalf("Secrets = %v", cfg.Secrets)
	}
}

func TestParseRejectsHostileYAML(t *testing.T) {
	t.Parallel()
	tests := map[string]string{
		"duplicate key":  "version: 1\nname: a\nname: b\n",
		"alias":          "a: &x 1\nb: *x\n",
		"non string key": "1: x\n",
		"binary tag":     "name: !!binary aGVsbG8=\n",
		"custom tag":     "name: !custom x\n",
		"broken syntax":  "name: [unclosed\n",
		"too large":      "# " + strings.Repeat("x", config.MaxConfigBytes+1),
		"billion laughs": "a: &a [x]\nb: &b [*a,*a]\nc: &c [*b,*b]\nd: [*c,*c]\n",
		"merge key":      "base: &b {x: 1}\nname: {<<: *b}\n",
	}
	for name, doc := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Parse([]byte(doc))
			var verr *config.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Parse() error = %v, want *ValidationError", err)
			}
		})
	}
}

func TestYAML11BooleansStayStrings(t *testing.T) {
	t.Parallel()
	cfg, err := config.Load([]byte("version: 1\nname: api\nbuild:\n  type: dockerfile\nrun:\n  port: 1\nenv:\n  FLAG: yes\n"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got := cfg.Env["FLAG"]; got != "yes" {
		t.Fatalf("Env[FLAG] = %v, want \"yes\"", got)
	}
}

func TestValidateReportsUnknownKeyLocation(t *testing.T) {
	t.Parallel()
	_, err := config.Load([]byte("version: 1\nname: api\nbuild:\n  type: dockerfile\nrun:\n  port: 3000\n  prot: 1\n"))
	var verr *config.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("Load() error = %v", err)
	}
	found := false
	for _, issue := range verr.Issues {
		if issue.Path == "/run" && strings.Contains(issue.Message, "prot") {
			found = true
		}
	}
	if !found {
		t.Fatalf("issues = %v, want one at /run naming prot", verr.Issues)
	}
}

// FuzzLoad is one of the fuzz targets required by THREAT_MODEL; nightly runs come with M10.2.
func FuzzLoad(f *testing.F) {
	for _, kind := range []string{"valid", "invalid"} {
		entries, err := os.ReadDir(filepath.Join(fixturesDir, kind))
		if err != nil {
			f.Fatalf("read fixtures: %v", err)
		}
		for _, e := range entries {
			data, err := os.ReadFile(filepath.Join(fixturesDir, kind, e.Name()))
			if err != nil {
				f.Fatalf("read fixture: %v", err)
			}
			f.Add(data)
		}
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		cfg, err := config.Load(data)
		if err == nil && cfg == nil {
			t.Fatal("Load() returned nil config without error")
		}
		if err != nil {
			var verr *config.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Load() returned a non-validation error: %v", err)
			}
		}
	})
}
