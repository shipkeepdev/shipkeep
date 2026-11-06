#!/usr/bin/env bash
# Input boundary checks stop before any privileged effects, including under bash -x.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
pin=$(printf 'a%.0s' {1..64})
token=$(printf 'J%.0s' {1..43})
# shellcheck disable=SC2016
for address in 'example.com:0' 'example.com:65536' '$(id):7443' "example.com:7443'" $'example.com:7443\n'; do
  if printf '%s\n' "$token" | bash -x deploy/install.sh --control-plane "$address" --ca-fingerprint "sha256:$pin" --origin https://example.com --amd64-sha256 "$pin" --arm64-sha256 "$pin" >"$work/output" 2>&1; then
    exit 1
  fi
  if grep -q "$token" "$work/output"; then exit 1; fi
  grep -q 'Invalid gateway' "$work/output"
done
printf 'Installer input and redaction checks passed.\n'
