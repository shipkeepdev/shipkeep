#!/usr/bin/env sh
# Generates the Go side of the shipkeep.yml contract from packages/config-schema/shipkeep.schema.json:
#   lib/config/types.gen.go        typed structs (go-jsonschema, models only)
#   lib/config/shipkeep.schema.json embedded copy used by the Go validator
# Run through `pnpm gen`. Output is committed and never edited by hand (CLAUDE.md, rule 9).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SCHEMA="$ROOT/packages/config-schema/shipkeep.schema.json"
OUT_DIR="$ROOT/lib/config"
GO_JSONSCHEMA_VERSION=v0.24.1

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# go-jsonschema names the root type after the file name, so the copy is named for the type we want.
cp "$SCHEMA" "$TMP/shipkeep-config.json"

GOWORK=off go run "github.com/atombender/go-jsonschema@$GO_JSONSCHEMA_VERSION" \
  --package config \
  --only-models \
  --disable-custom-types-for-maps \
  --output "$TMP/types.gen.go" \
  "$TMP/shipkeep-config.json"

# The generator appends "Json" to the root type; the contract calls it ShipkeepConfig.
sed 's/ShipkeepConfigJson/ShipkeepConfig/g' "$TMP/types.gen.go" > "$OUT_DIR/types.gen.go"
gofmt -w "$OUT_DIR/types.gen.go"
cp "$SCHEMA" "$OUT_DIR/shipkeep.schema.json"

echo "generated $OUT_DIR/types.gen.go and shipkeep.schema.json"
