// Package agentproto offers helpers around the generated agent protocol types in lib/gen.
//
// It is the only hand-written Go code that reasons about the action catalogue as a whole, so the
// agent journal, the control plane tests and the fuzz targets agree on action names.
package agentproto

import (
	"google.golang.org/protobuf/reflect/protoreflect"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// ActionKinds returns the field names of the `action` oneof of ActionRequest in declaration
// order, for example "ensure_network". It is derived from the descriptor so it cannot drift from
// the proto contract.
func ActionKinds() []string {
	oneof := actionOneof()
	fields := oneof.Fields()
	kinds := make([]string, 0, fields.Len())
	for i := range fields.Len() {
		kinds = append(kinds, string(fields.Get(i).Name()))
	}
	return kinds
}

// ActionKind returns the field name of the action carried by req, or "" when none is set.
func ActionKind(req *agentv1.ActionRequest) string {
	if req == nil {
		return ""
	}
	field := req.ProtoReflect().WhichOneof(actionOneof())
	if field == nil {
		return ""
	}
	return string(field.Name())
}

func actionOneof() protoreflect.OneofDescriptor {
	desc := (&agentv1.ActionRequest{}).ProtoReflect().Descriptor()
	return desc.Oneofs().ByName("action")
}
