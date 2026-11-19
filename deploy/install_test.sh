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
# The egress guard of the Docker daemon (ADR 0023): only loopback name servers, normalized, become
# exceptions, and only docker.service's cgroup is matched.
cat >"$work/resolv.conf" <<'RESOLV'
# nameserver 127.0.0.9
nameserver 127.0.0.53
nameserver 127.000.0.1
nameserver 8.8.8.8
nameserver 127.0.0.256
nameserver 127.0.0.2 # local resolver
nameserver 127.0.0.3; another comment
nameserver 127.0.0.1 extra
nameserver ::1
nameserver 0:0:0:0:0:0:0:1
nameserver 0000::0001
nameserver ::2
nameserver ::1:1
nameserver :::1
nameserver 0:0:0:0:0:0:0:0:1
nameserver ::ffff:127.0.0.1
nameserver $(id)
options edns0 trust-ad
search example.com
RESOLV
[[ $(loopback_nameservers "$work/resolv.conf" | tr '\n' ' ') == '127.0.0.53 127.0.0.1 127.0.0.2 127.0.0.3 ::1 ::1 ::1 ' ]] || die "loopback name servers: $(loopback_nameservers "$work/resolv.conf" | tr '\n' ' ')"
guard=$(printf '127.0.0.53\n::1\n' | egress_guard /shipkeep.slice) || die 'the guard was refused'
grep -qxF '    socket cgroupv2 level 1 "shipkeep.slice" ct state new jump docker' <<<"$guard" || die 'the guard does not match the slice'
grep -qxF '    ip daddr 127.0.0.1 tcp dport 7480 return' <<<"$guard" || die 'the proxy is not allowed'
grep -qxF '    meta l4proto { tcp, udp } ct original ip daddr 127.0.0.53 ct original proto-dst 53 return' <<<"$guard" || die 'the name server is not allowed'
grep -qxF '    meta l4proto { tcp, udp } ct original ip6 daddr ::1 ct original proto-dst 53 return' <<<"$guard" || die 'the IPv6 name server is not allowed'
grep -qxF '    ip daddr 127.0.0.0/8 reject' <<<"$guard" || die 'loopback is not refused'
grep -qxF '    ip6 daddr ::1 reject' <<<"$guard" || die 'IPv6 loopback is not refused'
[[ $(grep -c ' return$' <<<"$guard") == 3 ]] || die 'unexpected exceptions'
printf '' | egress_guard /system.slice/docker-0123.scope/shipkeep.slice | grep -qF 'level 3 "system.slice/docker-0123.scope/shipkeep.slice"' || die 'a nested cgroup'
# shellcheck disable=SC2016
for cgroup in '' / shipkeep.slice /system.slice/docker.service /system.slice/evil.slice /shipkeep.slice/docker.service '/shipkeep.slice"' '/shipkeep.slice; drop' $'/shipkeep.slice\n' '/$(id)/shipkeep.slice' '/system slice/shipkeep.slice'; do
  refused egress_guard "$cgroup" </dev/null || die "accepted the cgroup $cgroup"
done
# A proxy in daemon.json would win over the egress proxy.
printf '{"log-driver":"json-file"}\n' >"$work/daemon.json"
daemon_json_without_proxies "$work/daemon.json" || die 'daemon.json without a proxy'
daemon_json_without_proxies "$work/missing.json" || die 'no daemon.json'
for key in proxies http-proxy https-proxy no-proxy; do
  printf '{"%s":"x"}\n' "$key" >"$work/daemon.json"
  refused daemon_json_without_proxies "$work/daemon.json" || die "accepted $key in daemon.json"
done
# What the daemon reports must be exactly the egress proxy, without exception.
egress_proxies_applied <<<'{"ID":"x","HttpProxy":"http://127.0.0.1:7480","HttpsProxy":"http://127.0.0.1:7480","NoProxy":"","Name":"n"}' || die 'the egress proxy was not recognized'
for info in '{}' '{"HttpProxy":"","HttpsProxy":"","NoProxy":""}' \
  '{"HttpProxy":"http://127.0.0.1:7480","HttpsProxy":"http://127.0.0.1:7480","NoProxy":"*"}' \
  '{"HttpProxy":"http://127.0.0.1:7480","HttpsProxy":"http://10.0.0.5:3128","NoProxy":""}' \
  '{"HttpProxy":"http://127.0.0.1:74800","HttpsProxy":"http://127.0.0.1:74800","NoProxy":""}'; do
  refused egress_proxies_applied <<<"$info" || die "accepted $info"
done
# shellcheck source=/dev/null
. deploy/docker-repository-test.sh
check_docker_repository deploy/install.sh "$work/apt"
printf 'Installer input, redaction, signing-key and egress checks passed.\n'
