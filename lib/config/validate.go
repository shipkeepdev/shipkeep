// Package config parses and validates shipkeep.yml documents against the JSON Schema that is the
// contract of SPEC section 2. The schema file embedded here is a generated copy of
// packages/config-schema/shipkeep.schema.json; the TypeScript validator uses the same file, and the
// golden fixtures prove both sides agree.
package config

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"gopkg.in/yaml.v3"
)

// Validation messages are produced in English only (SPEC section 15, internationalization).
var messagePrinter = message.NewPrinter(language.English)

//go:embed shipkeep.schema.json
var schemaJSON []byte

// MaxConfigBytes is the upper bound on a shipkeep.yml document.
const MaxConfigBytes = 256 * 1024

// Issue is one validation problem, located by a JSON pointer into the document.
type Issue struct {
	// Path is a JSON pointer such as "/run/port". Empty means the root.
	Path    string
	Message string
}

func (i Issue) String() string {
	if i.Path == "" {
		return i.Message
	}
	return i.Path + ": " + i.Message
}

// ValidationError is returned when a document does not satisfy the schema.
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	parts := make([]string, 0, len(e.Issues))
	for _, issue := range e.Issues {
		parts = append(parts, issue.String())
	}
	return "invalid shipkeep.yml: " + strings.Join(parts, "; ")
}

var (
	compileOnce sync.Once
	compiled    *jsonschema.Schema
	errCompile  error
)

func schema() (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
		if err != nil {
			errCompile = fmt.Errorf("decode embedded schema: %w", err)
			return
		}
		c := jsonschema.NewCompiler()
		c.DefaultDraft(jsonschema.Draft2020)
		if err := c.AddResource("shipkeep.schema.json", doc); err != nil {
			errCompile = fmt.Errorf("register embedded schema: %w", err)
			return
		}
		compiled, err = c.Compile("shipkeep.schema.json")
		if err != nil {
			errCompile = fmt.Errorf("compile embedded schema: %w", err)
		}
	})
	return compiled, errCompile
}

// Parse decodes YAML into a JSON-compatible value (maps with string keys, []any, json.Number,
// string, bool, nil) without validating it.
func Parse(data []byte) (any, error) {
	if len(data) > MaxConfigBytes {
		return nil, &ValidationError{Issues: []Issue{{Message: fmt.Sprintf("document exceeds %d bytes", MaxConfigBytes)}}}
	}

	var node yaml.Node
	if err := yaml.Unmarshal(data, &node); err != nil {
		return nil, &ValidationError{Issues: []Issue{{Message: "invalid YAML: " + err.Error()}}}
	}
	if node.Kind == 0 {
		// Empty document.
		return nil, nil
	}
	value, err := toJSONValue(&node)
	if err != nil {
		return nil, &ValidationError{Issues: []Issue{{Message: err.Error()}}}
	}
	return value, nil
}

// Validate checks a parsed document against the schema.
func Validate(value any) error {
	s, err := schema()
	if err != nil {
		return err
	}
	err = s.Validate(value)
	if err == nil {
		return nil
	}
	var verr *jsonschema.ValidationError
	if !errors.As(err, &verr) {
		return fmt.Errorf("validate shipkeep.yml: %w", err)
	}
	return &ValidationError{Issues: collectIssues(verr)}
}

// Load parses and validates a shipkeep.yml document and decodes it into typed configuration.
func Load(data []byte) (*ShipkeepConfig, error) {
	value, err := Parse(data)
	if err != nil {
		return nil, err
	}
	if err := Validate(value); err != nil {
		return nil, err
	}
	// Round-trip through JSON so the generated struct tags apply.
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode shipkeep.yml: %w", err)
	}
	var cfg ShipkeepConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("decode shipkeep.yml: %w", err)
	}
	return &cfg, nil
}

// toJSONValue converts a YAML node tree into the value model the schema validator expects.
// Only the YAML 1.2 core schema is honoured: `yes`, `on` and friends stay strings, and keys must
// be strings. Duplicate keys and aliases are rejected because shipkeep.yml never needs them.
func toJSONValue(n *yaml.Node) (any, error) {
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return toJSONValue(n.Content[0])
	case yaml.MappingNode:
		out := make(map[string]any, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if k.Kind != yaml.ScalarNode || (k.Tag != "!!str" && k.Tag != "") {
				return nil, fmt.Errorf("line %d: mapping keys must be strings", k.Line)
			}
			if _, dup := out[k.Value]; dup {
				return nil, fmt.Errorf("line %d: duplicate key %q", k.Line, k.Value)
			}
			child, err := toJSONValue(v)
			if err != nil {
				return nil, err
			}
			out[k.Value] = child
		}
		return out, nil
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			child, err := toJSONValue(c)
			if err != nil {
				return nil, err
			}
			out = append(out, child)
		}
		return out, nil
	case yaml.ScalarNode:
		return scalarValue(n)
	case yaml.AliasNode:
		return nil, fmt.Errorf("line %d: YAML aliases are not allowed", n.Line)
	default:
		return nil, fmt.Errorf("line %d: unsupported YAML node", n.Line)
	}
}

func scalarValue(n *yaml.Node) (any, error) {
	switch n.Tag {
	case "!!str":
		return n.Value, nil
	case "!!null":
		return nil, nil
	case "!!bool":
		// yaml.v3 resolves only true/false (YAML 1.2 core) to !!bool; yes/no stay !!str.
		return n.Value == "true", nil
	case "!!int", "!!float":
		num := json.Number(n.Value)
		if _, err := num.Float64(); err != nil {
			return nil, fmt.Errorf("line %d: invalid number %q", n.Line, n.Value)
		}
		return num, nil
	case "!!binary", "!!timestamp", "!!merge":
		return nil, fmt.Errorf("line %d: YAML tag %s is not allowed", n.Line, n.Tag)
	default:
		if strings.HasPrefix(n.Tag, "!") {
			return nil, fmt.Errorf("line %d: custom YAML tags are not allowed", n.Line)
		}
		return n.Value, nil
	}
}

// collectIssues flattens the validator's error tree into leaf issues with JSON pointers.
func collectIssues(err *jsonschema.ValidationError) []Issue {
	var issues []Issue
	seen := map[string]struct{}{}
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			issue := Issue{Path: pointer(e.InstanceLocation), Message: e.ErrorKind.LocalizedString(messagePrinter)}
			key := issue.Path + "\x00" + issue.Message
			if _, dup := seen[key]; !dup {
				seen[key] = struct{}{}
				issues = append(issues, issue)
			}
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(err)
	return issues
}

func pointer(location []string) string {
	if len(location) == 0 {
		return ""
	}
	var b strings.Builder
	for _, seg := range location {
		b.WriteByte('/')
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(seg, "~", "~0"), "/", "~1"))
	}
	return b.String()
}
