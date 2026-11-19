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
# Only the pinned signing key reaches apt, whatever else a downloaded key file holds.
# shellcheck source=/dev/null
. deploy/install.sh
refused() { ! ("$@") 2>/dev/null; }
die() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }
keys=$work/keys
mkdir -m 0700 "$keys"
for name in first second; do
  gpg --homedir "$keys" --batch --quiet --passphrase '' --quick-generate-key "$name@example.com" ed25519 sign never 2>/dev/null
  gpg --homedir "$keys" --batch --quiet --armor --export "$name@example.com" >"$work/$name.asc"
done
first=$(gpg --homedir "$keys" --batch --with-colons --list-keys first@example.com 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
[[ ${#first} == 40 ]] || die 'no test key'
cat "$work/first.asc" "$work/second.asc" >"$work/first-then-second.asc"
cat "$work/second.asc" "$work/first.asc" >"$work/second-then-first.asc"
gpg --homedir "$keys" --batch --quiet --armor --export first@example.com second@example.com >"$work/one-block.asc"
printf 'not a key\n' >"$work/garbage.asc"
single_signing_key "$work/first.asc" "$work/first.gpg" "$first" || die 'the expected key alone was refused'
# apt is given gpg's own export of that key, never the downloaded bytes.
! grep -q 'BEGIN PGP' "$work/first.gpg" || die 'the downloaded file was installed as it came'
[[ $(gpg --homedir "$keys" --batch --show-keys --with-colons "$work/first.gpg" | grep -c '^pub:') == 1 ]] || die 'the installed keyring does not hold one key'
gpg --homedir "$keys" --batch --show-keys --with-colons "$work/first.gpg" | grep -q "^fpr:.*:$first:" || die 'the installed keyring holds another key'
gpgconf --homedir "$keys" --kill all
for file in second.asc first-then-second.asc second-then-first.asc one-block.asc garbage.asc missing.asc; do
  refused single_signing_key "$work/$file" "$work/refused.gpg" "$first" || die "accepted the key file $file"
  [[ ! -s $work/refused.gpg ]] || die "a keyring was written from $file"
done
# shellcheck source=/dev/null
. deploy/docker-repository-test.sh
check_docker_repository deploy/install.sh "$work/apt"
printf 'Installer input, redaction and signing-key checks passed.\n'
