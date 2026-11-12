#!/usr/bin/env bash
# Produce deployment artifacts; never commit the resulting binaries or manifest.
set -euo pipefail
cd "$(dirname "$0")/.."
output=apps/web/public/install
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# An image build has no git history: it passes both values in.
version=${SHIPKEEP_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || printf dev)}
commit=${SHIPKEEP_COMMIT:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}
buildinfo=github.com/shipkeepdev/shipkeep/lib/buildinfo
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -buildvcs=false -ldflags="-s -w -X $buildinfo.Version=$version -X $buildinfo.Commit=$commit" -o "$work/$arch" ./agent/cmd/shipkeep-agent
  digest=$(sha256sum "$work/$arch" | cut -d ' ' -f 1)
  install -m 0644 "$work/$arch" "$work/agent-$digest.bin"
  printf '%s' "$digest" > "$work/$arch.sha"
done
rm -f "$output"/agent-*.bin "$output"/install-*.sh
install -m 0644 "$work"/agent-*.bin "$output/"
digest=$(sha256sum deploy/install.sh | cut -d ' ' -f 1)
install -m 0644 deploy/install.sh "$output/install-$digest.sh"
printf '{"installer":"%s","amd64":"%s","arm64":"%s"}\n' "$digest" "$(cat "$work/amd64.sha")" "$(cat "$work/arm64.sha")" > "$output/manifest.json"
