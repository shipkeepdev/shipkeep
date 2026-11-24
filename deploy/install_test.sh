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
# The installer points Docker where the proxy listens and where the agent expects it.
grep -qxF 'const Address = "127.0.0.1:7480"' agent/internal/egress/proxy.go || die 'the proxy listens elsewhere'
# shellcheck disable=SC2154 # egress_proxy is set by deploy/install.sh, sourced above.
grep -qxF "const EgressProxy = \"$egress_proxy\"" agent/internal/actions/docker.go || die 'the agent expects another proxy'
# shellcheck disable=SC2154 # as above.
[[ $egress_proxy == "http://127.0.0.1:7480" ]] || die 'the installer points Docker elsewhere'
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
# Single machine (ADR 0021): memory protection needs cgroup v2 with memory_recursiveprot.
printf 'cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot 0 0\n' >"$work/mounts"
cgroup2_recursiveprot "$work/mounts" || die 'memory_recursiveprot not found'
for mounts in 'cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate 0 0' \
  'cgroup2 /sys/fs/cgroup/unified cgroup2 rw,memory_recursiveprot 0 0' \
  'tmpfs /sys/fs/cgroup tmpfs ro,memory_recursiveprot 0 0' \
  'cgroup2 /sys/fs/cgroup cgroup2 rw,memory_recursiveprotx 0 0' \
  'cgroup2 /sys/fs/cgroup cgroup2 rw,xmemory_recursiveprot 0 0'; do
  printf '%s\n' "$mounts" >"$work/mounts"
  refused cgroup2_recursiveprot "$work/mounts" || die "accepted the mounts $mounts"
done
printf 'MemTotal:        4028292 kB\nMemFree: 1 kB\n' >"$work/meminfo"
[[ $(memory_total_bytes "$work/meminfo") == 4124971008 ]] || die 'memory misread'
for meminfo in 'MemTotal: 4028292 MB' 'MemTotal: lots kB' 'MemTotal: 1e9 kB' 'MemFree: 4028292 kB'; do
  printf '%s\n' "$meminfo" >"$work/meminfo"
  refused memory_total_bytes "$work/meminfo" || die "accepted the meminfo $meminfo"
done
valid_local_control_plane 127.0.0.1:3000 || die 'the local control plane address was refused'
# shellcheck disable=SC2016
for address in 127.0.0.1 127.0.0.1:0 127.0.0.1:65536 127.0.0.2:3000 0.0.0.0:3000 '[::1]:3000' localhost:3000 \
  '127.0.0.1:3000 ' $'127.0.0.1:3000\n' '127.0.0.1:$(id)'; do
  refused valid_local_control_plane "$address" || die "accepted the local control plane $address"
done
# The applications get the machine minus the reservation, and a lower CPU weight.
unit=$(workloads_slice_unit 4294967296) || die 'no workloads slice'
[[ $unit == *$'\n[Slice]\nMemoryMax=3221225472\nCPUWeight=50' ]] || die "workloads slice: $unit"
refused workloads_slice_unit 1073741824 || die 'a slice without room was written'
# The agent's unit runs the upgrade guard first, and waits for the agent's READY (ADR 0028).
unit=$(agent_unit) || die 'no agent unit'
for line in Type=notify NotifyAccess=main StartLimitIntervalSec=0 TimeoutStartSec=360 Restart=always \
  'ExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/shipkeep/agent.yaml'; do
  [[ $unit == *$'\n'"$line"$'\n'* ]] || die "agent unit lacks $line"
done
[[ ${unit%%ExecStart=*} == *ExecStartPre=* ]] || die 'the upgrade guard runs after the agent'
[[ $unit != *OnFailure=* ]] || die 'the agent unit has an OnFailure rollback'
[[ $unit == *$'\nAfter=network-online.target docker.service shipkeep-caddy.service systemd-tmpfiles-setup.service\nWants=network-online.target shipkeep-caddy.service\n'* ]] || die 'a server agent does not wait for its Caddy'
# On a control plane machine there is no Caddy of the agent's own to wait for, and the same guard.
alone=$(agent_unit control-plane-only) || die 'no control-plane-only agent unit'
[[ $alone != *shipkeep-caddy* ]] || die 'a control-plane-only agent waits for a Caddy it has not'
[[ ${alone//$'\nAfter=network-online.target docker.service systemd-tmpfiles-setup.service\nWants=network-online.target\n'/$'\n'} == "${unit//$'\nAfter=network-online.target docker.service shipkeep-caddy.service systemd-tmpfiles-setup.service\nWants=network-online.target shipkeep-caddy.service\n'/$'\n'}" ]] ||
  die 'the control-plane-only agent unit differs in more than Caddy'
caddy=$(caddy_unit) || die 'no Caddy unit'
for line in 'ExecStart=/usr/bin/caddy run --resume --config /etc/shipkeep-caddy.json' User=shipkeep-caddy CapabilityBoundingSet=CAP_NET_BIND_SERVICE ReadWritePaths=/run/shipkeep; do
  [[ $caddy == *$'\n'"$line"$'\n'* ]] || die "Caddy unit lacks $line"
done
# The agent refuses an upgrade unless its unit runs the guard it looks for, as an active line.
guard_exe=$(sed -n 's/^\tguardExecutable *= "\(.*\)"$/\1/p' agent/internal/actions/upgrade.go)
guard_cmd=$(sed -n 's/^\tguardCommand *= "\(.*\)"$/\1/p' agent/internal/actions/upgrade.go)
[[ -n $guard_exe && -n $guard_cmd && $unit == *$'\n'"ExecStartPre=$guard_exe $guard_cmd "* ]] ||
  die "the agent looks for another guard: $guard_exe $guard_cmd"
# A refused single-machine option stops before anything else, and never shows the token.
for options in '--local-control-plane 0.0.0.0:3000 --agent-file /bin/true' '--local-control-plane 127.0.0.1:3000' \
  '--local-control-plane 127.0.0.1:3000 --agent-file relative/agent' '--local-control-plane 127.0.0.1:3000 --agent-file /missing/agent'; do
  # shellcheck disable=SC2086 # the options are words on purpose
  if printf '%s\n' "$token" | bash deploy/install.sh --control-plane example.com:7443 --ca-fingerprint "sha256:$pin" --origin https://example.com --amd64-sha256 "$pin" --arm64-sha256 "$pin" $options >"$work/output" 2>&1; then
    die "accepted $options"
  fi
  if grep -q "$token" "$work/output"; then die 'the token was shown'; fi
  grep -Eq 'local control plane|agent file|--agent-file' "$work/output" || die "refused $options for another reason: $(cat "$work/output")"
done
# A refused control-plane-only option stops before anything else, and never shows the token. The
# agent file is a regular file: /bin/true can be a link, which is refused first.
: >"$work/agent"
for options in "--control-plane-only no --agent-file $work/agent" '--control-plane-only yes' \
  "--control-plane-only yes --agent-file $work/agent --local-control-plane 127.0.0.1:3000" "--control-plane-only \$(id) --agent-file $work/agent"; do
  # shellcheck disable=SC2086 # the options are words on purpose
  if printf '%s\n' "$token" | bash deploy/install.sh --control-plane example.com:7443 --ca-fingerprint "sha256:$pin" --origin https://example.com --amd64-sha256 "$pin" --arm64-sha256 "$pin" $options >"$work/output" 2>&1; then
    die "accepted $options"
  fi
  if grep -q "$token" "$work/output"; then die 'the token was shown'; fi
  grep -Eq 'control-plane-only|control plane machine' "$work/output" || die "refused $options for another reason: $(cat "$work/output")"
done
# shellcheck source=/dev/null
. deploy/docker-repository-test.sh
check_docker_repository deploy/install.sh "$work/apt"
printf 'Installer input, redaction, signing-key, egress, single-machine and control-plane-only checks passed.\n'
