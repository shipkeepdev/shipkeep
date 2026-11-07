package secret_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const raw = "sk_test_fake_do_not_leak_9f8e7d"

func TestExposeReturnsValue(t *testing.T) {
	t.Parallel()
	s := secret.NewString(raw)
	if s.Expose() != raw {
		t.Fatalf("Expose() = %q", s.Expose())
	}
	if s.IsZero() || !secret.NewString("").IsZero() {
		t.Fatal("IsZero() wrong")
	}
}

func TestEveryFormattingPathRedacts(t *testing.T) {
	t.Parallel()
	s := secret.NewString(raw)
	outputs := map[string]string{
		"String":  s.String(),
		"%v":      fmt.Sprintf("%v", s),
		"%+v":     fmt.Sprintf("%+v", s),
		"%s":      fmt.Sprintf("%s", s),
		"%q":      fmt.Sprintf("%q", s),
		"%x":      fmt.Sprintf("%x", s),
		"%#v":     fmt.Sprintf("%#v", s),
		"Sprint":  fmt.Sprint(s),
		"pointer": fmt.Sprintf("%v", &s),
	}
	for name, out := range outputs {
		if strings.Contains(out, raw) {
			t.Errorf("%s leaked the secret: %q", name, out)
		}
		if !strings.Contains(out, secret.Redacted) {
			t.Errorf("%s = %q, want it to contain %q", name, out, secret.Redacted)
		}
	}
}

func TestStructFormattingRedacts(t *testing.T) {
	t.Parallel()
	type creds struct {
		User     string
		Password secret.String
	}
	c := creds{User: "shipkeep", Password: secret.NewString(raw)}
	for _, out := range []string{fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c)} {
		if strings.Contains(out, raw) {
			t.Fatalf("struct formatting leaked the secret: %q", out)
		}
	}
}

func TestJSONAndYAMLRedact(t *testing.T) {
	t.Parallel()
	type creds struct {
		Password secret.String `json:"password" yaml:"password"`
	}
	c := creds{Password: secret.NewString(raw)}

	j, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(j), raw) || !strings.Contains(string(j), secret.Redacted) {
		t.Fatalf("json = %s", j)
	}

	y, err := yaml.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(y), raw) || !strings.Contains(string(y), secret.Redacted) {
		t.Fatalf("yaml = %s", y)
	}
}

func TestJSONAndYAMLDecode(t *testing.T) {
	t.Parallel()
	type creds struct {
		Password secret.String `json:"password" yaml:"password"`
	}
	var fromJSON creds
	if err := json.Unmarshal([]byte(`{"password":"`+raw+`"}`), &fromJSON); err != nil {
		t.Fatal(err)
	}
	if fromJSON.Password.Expose() != raw {
		t.Fatalf("json decode = %q", fromJSON.Password.Expose())
	}
	var fromYAML creds
	if err := yaml.Unmarshal([]byte("password: "+raw+"\n"), &fromYAML); err != nil {
		t.Fatal(err)
	}
	if fromYAML.Password.Expose() != raw {
		t.Fatalf("yaml decode = %q", fromYAML.Password.Expose())
	}
	if err := json.Unmarshal([]byte(`{"password":42}`), &fromJSON); err == nil {
		t.Fatal("non-string JSON secret should fail to decode")
	}
}

func TestSlogRedacts(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	for _, handler := range []slog.Handler{
		slog.NewJSONHandler(&buf, nil),
		slog.NewTextHandler(&buf, nil),
	} {
		logger := slog.New(handler)
		logger.Info("login", "token", secret.NewString(raw), slog.Any("nested", secret.NewString(raw)))
	}
	if strings.Contains(buf.String(), raw) {
		t.Fatalf("slog leaked the secret: %s", buf.String())
	}
	if strings.Count(buf.String(), secret.Redacted) < 4 {
		t.Fatalf("slog output = %s", buf.String())
	}
}

func TestEqual(t *testing.T) {
	t.Parallel()
	a, b, c := secret.NewString("abc"), secret.NewString("abc"), secret.NewString("abd")
	if !a.Equal(b) || a.Equal(c) || a.Equal(secret.NewString("ab")) {
		t.Fatal("Equal() wrong")
	}
}
