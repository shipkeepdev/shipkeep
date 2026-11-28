#!/usr/bin/env bash
# Fresh Ubuntu 24.04 nodes only. Run the checksum-verified copy shown by the control plane.
set +ax
set -euo pipefail
fail() { printf 'shipkeep-install: %s\n' "$1" >&2; exit 1; }
# Writes to $2 a keyring that holds the key with fingerprint $3 and nothing else, taken from the
# downloaded file $1. It fails unless that file holds exactly this one key: apt trusts every key
# of the keyring a repository names, so a second key in the download would be trusted too.
# (deploy/control-plane/install.sh carries the same function: each installer is a single file.)
single_signing_key() {
  local home listed status=1
  home=$(mktemp -d -- "${2%/*}/gnupg.XXXXXX") || return 1
  if gpg --homedir "$home" --batch --quiet --import "$1" 2>/dev/null; then
    listed=$(gpg --homedir "$home" --batch --quiet --with-colons --list-keys 2>/dev/null | awk -F: '$1=="pub" {keys++} $1=="fpr" && !first {first=$10} END {print keys ":" first}')
    if [[ $listed == "1:$3" ]] && gpg --homedir "$home" --batch --quiet --export "$3" >"$2" 2>/dev/null && [[ -s $2 ]]; then status=0; fi
  fi
  rm -rf -- "$home"
  return "$status"
}
install_docker_packages() (
  # shellcheck disable=SC2034
  local apt_dir=$1 work path index draft_keyring draft_sources keep_repository=0
  local -a draft_paths=()
  local sources=$apt_dir/sources.list.d/shipkeep-docker.sources keyring=$apt_dir/keyrings/shipkeep-docker.gpg
  local -a repository_paths=("$keyring" "$sources")
  for path in "$sources" "$keyring" "$apt_dir/keyrings/shipkeep-docker.asc"; do
    [[ ! -e $path && ! -L $path ]] || fail "Docker repository file already exists: $path. Reconcile $sources and $keyring (and any legacy $apt_dir/keyrings/shipkeep-docker.asc); if confirmed left before package application, remove them and run this installer again. If package application may have started, keep them and repair the package state before retrying."
  done
  apt-get update -qq </dev/null
  apt-get install -y --no-install-recommends ca-certificates curl gnupg </dev/null
  work=$(mktemp -d /tmp/shipkeep-docker.XXXXXX)
  trap '
    if (( ! keep_repository )); then
      for index in "${!draft_paths[@]}"; do
        path=${repository_paths[index]}
        if [[ ! -L $path && $path -ef ${draft_paths[index]} ]]; then
          rm -f -- "$path"
        fi
      done
    fi
    rm -f -- "${draft_paths[@]}"
    rm -rf -- "$work"
  ' EXIT
  trap 'exit 129' HUP
  trap 'exit 143' TERM
  printf 'Docker signing-key workspace: %s\n' "$work" >&2
  curl --fail --silent --show-error --proto '=https' --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
  single_signing_key "$work/docker.asc" "$work/docker.gpg" 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 || fail 'Docker signing key mismatch.'
  install -d -m 0755 "$apt_dir/keyrings"
  # Stage each file in its destination directory so linking cannot replace an existing path.
  draft_keyring=$(mktemp "$apt_dir/keyrings/.shipkeep-docker.XXXXXX")
  draft_paths+=("$draft_keyring")
  install -m 0644 "$work/docker.gpg" "$draft_keyring"
  draft_sources=$(mktemp "$apt_dir/sources.list.d/.shipkeep-docker.XXXXXX")
  draft_paths+=("$draft_sources")
  cat >"$draft_sources" <<REPO
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: $keyring
REPO
  chmod 0644 "$draft_sources"
  ln -T -- "$draft_keyring" "$keyring" || fail "Cannot create Docker repository file: $keyring"
  ln -T -- "$draft_sources" "$sources" || fail "Cannot create Docker repository file: $sources"
  apt-get update -qq </dev/null
  apt-get install -y --download-only --no-install-recommends docker-ce docker-ce-cli containerd.io </dev/null
  # Keep the update source once package application can leave Docker installed.
  # shellcheck disable=SC2034
  keep_repository=1
  apt-get install -y --no-download --no-install-recommends docker-ce docker-ce-cli containerd.io </dev/null
)
# The egress proxy of the Docker daemon (ADR 0023). Its address is fixed: the agent checks it
# (agent/internal/actions EgressProxy) and the proxy listens there (agent/internal/egress).
egress_proxy=http://127.0.0.1:7480
# True when $1 is an IPv6 loopback address in any of its written forms (::1, 0:0:0:0:0:0:0:1, ...).
ipv6_loopback() {
  local address=${1,,} group
  local -a left right groups
  [[ $address == *:* && $address =~ ^[0:]*1$ ]] || return 1
  if [[ $address == *::* ]]; then
    [[ ${address#*::} != *::* ]] || return 1
    IFS=: read -r -a left <<<"${address%%::*}"
    IFS=: read -r -a right <<<"${address#*::}"
    ((${#left[@]} + ${#right[@]} <= 7)) || return 1
    groups=("${left[@]}" "${right[@]}")
  else
    IFS=: read -r -a groups <<<"$address"
    ((${#groups[@]} == 8)) || return 1
  fi
  for group in "${groups[@]}"; do
    [[ $group =~ ^[0-9a-f]{1,4}$ ]] || return 1
  done
}
# Prints the loopback name servers of the resolv.conf $1, one per line and normalized: an IPv4
# address in 127.0.0.0/8, or ::1. The Docker daemon resolves names through them, so the guard
# lets it reach them on port 53. A comment after the address is ignored, as Docker does; any
# other line is ignored.
loopback_nameservers() {
  local line keyword address rest
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%%[#;]*}
    read -r keyword address rest <<<"$line" || true
    [[ $keyword == nameserver && -n $address && -z $rest ]] || continue
    if [[ $address =~ ^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
      ((10#${BASH_REMATCH[1]} <= 255 && 10#${BASH_REMATCH[2]} <= 255 && 10#${BASH_REMATCH[3]} <= 255)) || continue
      printf '127.%d.%d.%d\n' "$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[3]}))"
    elif ipv6_loopback "$address"; then
      printf '::1\n'
    fi
  done <"$1"
}
# Prints the name servers of the resolv.conf $1, one per line: the IPv4 and IPv6 addresses
# slirp4netns forwards a build's names to (ADR 0030). Any other line is ignored.
resolv_nameservers() {
  local line keyword address rest
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%%[#;]*}
    read -r keyword address rest <<<"$line" || true
    [[ $keyword == nameserver && -n $address && -z $rest ]] || continue
    if [[ $address =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
      ((10#${BASH_REMATCH[1]} <= 255 && 10#${BASH_REMATCH[2]} <= 255 && 10#${BASH_REMATCH[3]} <= 255 && 10#${BASH_REMATCH[4]} <= 255)) || continue
      printf '%d.%d.%d.%d\n' "$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[3]}))" "$((10#${BASH_REMATCH[4]}))"
    elif [[ $address =~ ^[0-9A-Fa-f:.]{2,45}$ && $address == *:* ]]; then
      printf '%s\n' "${address,,}"
    fi
  done <"$1"
}
# What a build never reaches (ADR 0030): the egress proxy's ranges (agent/internal/egress), which
# a test compares with these, and IPv4-mapped addresses.
build_blocked_ipv4='0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4'
build_blocked_ipv6='::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8'
# Prints the nftables guard of ADR 0023 for the cgroup $1 of shipkeep.slice, which holds the
# Docker daemon: its new connections to loopback are rejected, except to the egress proxy and to
# the name servers read on standard input, port 53. It fails for a cgroup that is not the slice's.
# With the user id $2 of shipkeep-build, the builder's new connections (ADR 0030) reach public
# addresses only, on any port: never loopback, private, shared or link-local ranges, nor the
# server's own addresses but on port 443, where its Caddy serves what the internet sees (on a
# single machine, the control plane's registry), and the name servers $3… on port 53.
egress_guard() {
  local cgroup=$1 build=${2:-} level server family
  [[ $cgroup =~ ^(/[A-Za-z0-9@._:-]+)*/shipkeep\.slice$ ]] || return 1
  [[ -z $build || $build =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  shift $(($# < 2 ? $# : 2))
  for server; do
    [[ $server =~ ^[0-9a-f.:]{2,45}$ ]] || return 1
  done
  level=${cgroup//[^\/]/}
  printf 'destroy table inet shipkeep_egress\n'
  printf 'table inet shipkeep_egress {\n'
  printf '  chain output {\n'
  printf '    type filter hook output priority filter; policy accept;\n'
  printf '    socket cgroupv2 level %d "%s" ct state new jump docker\n' "${#level}" "${cgroup#/}"
  [[ -z $build ]] || printf '    meta skuid %d ct state new jump build\n' "$build"
  printf '  }\n'
  printf '  chain docker {\n'
  printf '    ip daddr 127.0.0.1 tcp dport 7480 return\n'
  while read -r server; do
    family=ip
    [[ $server == ::1 ]] && family=ip6
    # The original destination: a resolver may be reached through a DNAT to another port, as
    # Docker's embedded resolver (127.0.0.11) is inside a container.
    printf '    meta l4proto { tcp, udp } ct original %s daddr %s ct original proto-dst 53 return\n' "$family" "$server"
  done
  printf '    ip daddr 127.0.0.0/8 reject\n'
  printf '    ip6 daddr ::1 reject\n'
  printf '  }\n'
  if [[ -n $build ]]; then
    printf '  chain build {\n'
    for server; do
      family=ip
      [[ $server == *:* ]] && family=ip6
      printf '    meta l4proto { tcp, udp } ct original %s daddr %s ct original proto-dst 53 return\n' "$family" "$server"
    done
    printf '    fib daddr type local tcp dport 443 return\n'
    printf '    fib daddr type local reject\n'
    printf '    ip daddr { %s } reject\n' "$build_blocked_ipv4"
    printf '    ip6 daddr { %s } reject\n' "$build_blocked_ipv6"
    printf '  }\n'
  fi
  printf '}\n'
}
# Prints the first subordinate id after every range of the subuid and subgid files $@, at least
# 100000: the builder's 65536 ids never overlap another account's (Ubuntu's cloud images give
# 100000 to 165535 to ubuntu).
subordinate_start() {
  local file name start count end=100000
  for file; do
    [[ -f $file ]] || continue
    while IFS=: read -r name start count || [[ -n $name ]]; do
      [[ $start =~ ^[0-9]{1,10}$ && $count =~ ^[0-9]{1,10}$ ]] || continue
      if ((10#$start + 10#$count > end)); then end=$((10#$start + 10#$count)); fi
    done <"$file"
  done
  printf '%d\n' "$end"
}
# BuildKit builds applications from their repository (ADR 0030): the release this script pins,
# downloaded from GitHub and checked against these digests before any of it is kept. Only
# buildkitd and its runc are installed.
buildkit_version=v0.35.1
buildkit_amd64_sha256=b248c2b91698aafef11818fe8b681dc5e341581f7d5676709ff45ca1f29b0408
buildkit_arm64_sha256=46c7d1799250bd8b31266ed718715ab9d3464bad0455d5bfbe48e2eeb92ca965
# The builder's BuildKit configuration: one rootless OCI worker whose cache stays within 70 % of the
# builds' own filesystem (#548) and leaves a fifth of it free.
buildkitd_config() {
  cat <<'CONFIG'
root = "/var/lib/shipkeep-build/buildkit"
[log]
  format = "json"
[grpc]
  address = ["unix:///run/shipkeep-build/buildkitd.sock"]
[worker.oci]
  enabled = true
  rootless = true
  gc = true
  # Of the builds' own filesystem (#548): the cache may fill most of it, and a build the rest.
  maxUsedSpace = "70%"
  minFreeSpace = "20%"
[worker.containerd]
  enabled = false
# Frontends a build may run (#544): BuildKit's own Dockerfile frontend, the official one a
# Dockerfile may name with `# syntax=docker/dockerfile:…`, and Railpack's, which the agent pins.
# Any other `# syntax=` refuses the build.
[frontend."dockerfile.v0"]
  enabled = true
[frontend."gateway.v0"]
  enabled = true
  allowedRepositories = ["docker.io/docker/dockerfile", "ghcr.io/railwayapp/railpack-frontend"]
CONFIG
}
# The builds' slice: half the memory at most, a lower CPU weight than the applications.
builder_slice_unit() {
  cat <<'UNIT'
[Unit]
Description=Shipkeep builds
[Slice]
MemoryMax=50%
CPUWeight=50
UNIT
}
# The builder (ADR 0030): rootlesskit starts buildkitd in a user namespace of shipkeep-build,
# which is in no group that reaches Docker, with slirp4netns for its network and the host's
# loopback out of reach. It loads the egress guard, and its build rule, before it starts. Its
# socket is for the group shipkeep-build, which the agent's account is in.
builder_unit() {
  cat <<'UNIT'
[Unit]
Description=Shipkeep builder, rootless BuildKit
After=network-online.target shipkeep.slice
Wants=network-online.target
Requires=shipkeep.slice
# Its state lives on the builds' own filesystem (#548): never on the disk the applications use.
RequiresMountsFor=/var/lib/shipkeep-build
[Service]
User=shipkeep-build
Group=shipkeep-build
Slice=shipkeep-build.slice
Delegate=yes
Environment=XDG_RUNTIME_DIR=/run/shipkeep-build PATH=/usr/local/libexec/shipkeep-build:/usr/sbin:/usr/bin:/sbin:/bin
RuntimeDirectory=shipkeep-build
RuntimeDirectoryMode=0750
ExecStartPre=+/usr/sbin/nft --file /etc/shipkeep-egress.nft
# RequiresMountsFor orders the mount; this refuses to start on the bare directory under it.
ExecStartPre=/usr/bin/mountpoint -q /var/lib/shipkeep-build
ExecStart=/usr/bin/rootlesskit --net=slirp4netns --disable-host-loopback --copy-up=/etc --state-dir=/run/shipkeep-build/rootlesskit /usr/local/libexec/shipkeep-build/buildkitd --config /etc/shipkeep-build/buildkitd.toml
Restart=always
RestartSec=5
# A build is the first the kernel kills, before the applications and the control plane.
OOMScoreAdjust=1000
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
}
# Fails when the daemon.json $1 sets a proxy: Docker applies it before its environment, so the
# egress proxy would be bypassed.
daemon_json_without_proxies() {
  [[ ! -e $1 ]] || ! grep -Eq '"(proxies|http-proxy|https-proxy|no-proxy)"' "$1"
}
# True when the daemon's GET /info answer, on standard input, reports exactly the egress proxy for
# both schemes and no exception.
egress_proxies_applied() {
  local info
  info=$(cat)
  [[ $info == *"\"HttpProxy\":\"$egress_proxy\""* && $info == *"\"HttpsProxy\":\"$egress_proxy\""* && $info == *'"NoProxy":""'* ]]
}
# Checks that the Docker daemon can be put behind the egress proxy (ADR 0023). Nothing on the
# system changes but the nftables package.
prepare_egress() {
  daemon_json_without_proxies /etc/docker/daemon.json || fail 'Remove the proxy settings (proxies, http-proxy, https-proxy, no-proxy) from /etc/docker/daemon.json: Docker would apply them instead of the egress proxy.'
  command -v nft >/dev/null || apt-get install -y --no-install-recommends nftables </dev/null
  [[ -f /etc/nftables.conf ]] || fail 'nftables has no /etc/nftables.conf; reinstall the nftables package.'
}
# The share of the machine kept for the control plane and the system on a single machine (ADR 0021),
# and the smallest machine that leaves room for an application beside it.
reserved_cpu_millis=500
reserved_memory_bytes=1073741824
minimum_cpus=2
minimum_memory_bytes=3221225472
# True when the mounts file $1 has cgroup v2 on /sys/fs/cgroup with memory_recursiveprot: without
# it, MemoryLow stops at a slice and never reaches the container scopes below it (ADR 0021).
cgroup2_recursiveprot() {
  local target type options rest
  while read -r _ target type options rest; do
    [[ $target == /sys/fs/cgroup && $type == cgroup2 ]] || continue
    [[ ,$options, == *,memory_recursiveprot,* ]] && return 0
  done <"$1"
  return 1
}
# Prints the machine's memory in bytes, from the meminfo file $1.
memory_total_bytes() {
  local key value unit
  while read -r key value unit; do
    if [[ $key == MemTotal: && $value =~ ^[0-9]{1,15}$ && $unit == kB ]]; then
      printf '%d\n' "$((10#$value * 1024))"
      return 0
    fi
  done <"$1"
  return 1
}
# True when $1 is the control plane's HTTP address on this machine: 127.0.0.1 and a port.
valid_local_control_plane() {
  [[ $1 =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]] && ((10#${BASH_REMATCH[1]} > 0 && 10#${BASH_REMATCH[1]} <= 65535))
}
# The agent's unit (ADR 0028). systemd restarts the agent whatever happens (no start limit), and
# waits for its READY=1: at once on a normal start, after the control plane's welcome for a new
# binary. Before each start the upgrade guard, from the root-owned copy of the agent that an
# upgrade never replaces, counts a new binary's starts and puts the previous one back after three.
agent_unit() {
  local caddy=' shipkeep-caddy.service'
  # A control plane machine runs no Caddy of its own: the control plane's Caddy serves it.
  [[ ${1:-} != control-plane-only ]] || caddy=''
  cat <<UNIT
[Unit]
Description=Shipkeep node agent
After=network-online.target docker.service$caddy systemd-tmpfiles-setup.service
Wants=network-online.target$caddy
Requires=docker.service
StartLimitIntervalSec=0
[Service]
Type=notify
NotifyAccess=main
User=shipkeep
Group=shipkeep
SupplementaryGroups=docker
ExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard --config /etc/shipkeep/agent.yaml
ExecStart=/var/lib/shipkeep/bin/shipkeep-agent --config /etc/shipkeep/agent.yaml
TimeoutStartSec=360
Restart=always
RestartSec=5
# No capabilities: Caddy owns the ports, and WireGuard adds what it needs with M4.1.
CapabilityBoundingSet=
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/shipkeep /var/lib/shipkeep /run/shipkeep -/var/lib/shipkeep-build/exports
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
}
# The agent's unit as the installers of 0.1.0-alpha.1 to 0.1.0-alpha.3 wrote it: no upgrade guard,
# and no wait for a READY the agents of then never send. --migrate recognizes it (#490).
legacy_agent_unit() {
  cat <<'UNIT'
[Unit]
Description=Shipkeep node agent
After=network-online.target docker.service shipkeep-caddy.service systemd-tmpfiles-setup.service
Wants=network-online.target shipkeep-caddy.service
Requires=docker.service
[Service]
User=shipkeep
Group=shipkeep
SupplementaryGroups=docker
ExecStart=/var/lib/shipkeep/bin/shipkeep-agent --config /etc/shipkeep/agent.yaml
Restart=always
RestartSec=5
# No capabilities: Caddy owns the ports, and WireGuard adds what it needs with M4.1.
CapabilityBoundingSet=
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/shipkeep /var/lib/shipkeep /run/shipkeep
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
}
# Prints which installer wrote the server agent's unit $1: legacy (0.1.0-alpha.3 or earlier) or
# current. Any other text fails: a unit changed by hand is reconciled by hand, never overwritten.
agent_unit_layout() {
  local unit
  [[ -f $1 && ! -L $1 ]] || return 1
  unit=$(<"$1")
  if [[ $unit == "$(legacy_agent_unit)" ]]; then
    printf 'legacy\n'
  elif [[ $unit == "$(agent_unit)" || $unit == "$(agent_unit | sed 's| -/var/lib/shipkeep-build/exports$||')" ]]; then
    # The unit of before the builds' filesystem (#548) is rewritten like the current one.
    printf 'current\n'
  else
    return 1
  fi
}
# True when the agent configuration $1 is the one this installer writes for a server of the
# control plane at the gateway address $2, with the CA fingerprint $3: not another control plane's,
# and not a control plane machine's, which connects over loopback and has a role.
server_config_of() {
  [[ -f $1 && ! -L $1 ]] && grep -qxF "  address: '$2'" "$1" && grep -qxF "  ca_fingerprint: '$3'" "$1" &&
    ! grep -Eq '^[[:space:]]*(connect|role):' "$1"
}
# True when the Docker daemon already runs in the slice with cgroup $1, behind the egress proxy and
# its guard (ADR 0023): restarting it would change nothing.
docker_guarded() {
  [[ $(systemctl show --property ControlGroup --value docker.service) == "$1/docker.service" ]] &&
    nft list table inet shipkeep_egress >/dev/null 2>&1 &&
    curl --fail --silent --unix-socket /var/run/docker.sock http://localhost/v1.47/info | egress_proxies_applied
}
# Prints the unit of Caddy, the edge proxy of a server. Its admin API is a socket that only the
# agent's group reaches.
caddy_unit() {
  cat <<'UNIT'
[Unit]
Description=Shipkeep Caddy edge proxy
After=network-online.target systemd-tmpfiles-setup.service
Wants=network-online.target
[Service]
Type=notify
User=shipkeep-caddy
Group=shipkeep
# A crash can leave the socket behind.
ExecStartPre=-/usr/bin/rm -f /run/shipkeep/caddy-admin.sock
ExecStart=/usr/bin/caddy run --resume --config /etc/shipkeep-caddy.json
Restart=always
RestartSec=5
StateDirectory=shipkeep-caddy
StateDirectoryMode=0700
Environment=XDG_CONFIG_HOME=/var/lib/shipkeep-caddy/config XDG_DATA_HOME=/var/lib/shipkeep-caddy/data
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/run/shipkeep
UMask=0077
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
}
# Prints the slice of the applications on a single machine, whose memory is the machine's $1 bytes
# minus the reservation, and whose CPU weight is below the control plane's (ADR 0021).
workloads_slice_unit() {
  (($1 > reserved_memory_bytes)) || return 1
  printf '[Unit]\nDescription=Shipkeep: the applications of the machine that hosts the control plane\nBefore=slices.target\n'
  printf '[Slice]\nMemoryMax=%d\nCPUWeight=50\n' "$(($1 - reserved_memory_bytes))"
}
# A root-owned copy of the agent binary $1/agent, which runs the egress proxy and the upgrade guard
# (ADR 0023, ADR 0028): the agent's directory is private to its account, and that account must not
# be able to replace the binary the proxy and the guard run.
install_guard() {
  install -d -m 0755 /usr/local/libexec
  install -m 0755 -o root -g root "$1/agent" /usr/local/libexec/shipkeep-egress
}
# Puts the Docker daemon behind the egress proxy and the loopback guard, restarts Docker and checks
# what it applies (ADR 0023). $1 is a private work directory holding the verified agent binary
# ($1/agent); the account shipkeep-egress exists already.
#
# The guard matches the cgroup of shipkeep.slice, which holds the Docker daemon. The slice starts
# at boot, before nftables, and its cgroup lives as long as it runs: unlike the cgroup of
# docker.service, it exists whether Docker runs or not and does not change when Docker restarts.
# So nftables.service can load the guard in the same transaction as its own ruleset, at start,
# reload and stop, and no flush leaves Docker unguarded.
install_egress() {
  local attempt slice build
  install_guard "$1"
  cat > /etc/systemd/system/shipkeep-egress.service <<'UNIT'
[Unit]
Description=Shipkeep egress proxy of the Docker daemon
After=network-online.target
Wants=network-online.target
[Service]
User=shipkeep-egress
Group=shipkeep-egress
ExecStart=/usr/local/libexec/shipkeep-egress egress
Restart=always
RestartSec=5
CapabilityBoundingSet=
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/shipkeep.slice <<'UNIT'
[Unit]
Description=Shipkeep: the Docker daemon, behind the egress guard
DefaultDependencies=no
Before=slices.target nftables.service docker.service
[Install]
WantedBy=sysinit.target
UNIT
  # On a single machine it also holds the control plane's and the applications' slices, and protects
  # the reservation: memory protection reaches a cgroup only through protected ancestors (ADR 0021).
  if [[ -n $local_control_plane ]]; then
    printf '[Slice]\nMemoryLow=%d\n' "$reserved_memory_bytes" >>/etc/systemd/system/shipkeep.slice
  fi
  chmod 0644 /etc/systemd/system/shipkeep-egress.service /etc/systemd/system/shipkeep.slice
  systemctl daemon-reload
  systemctl enable --now shipkeep.slice
  slice=$(systemctl show --property ControlGroup --value shipkeep.slice)
  build=$(id -u shipkeep-build) || fail 'The builder account is missing.'
  # shellcheck disable=SC2046 # one argument per name server
  loopback_nameservers /etc/resolv.conf | egress_guard "$slice" "$build" $(resolv_nameservers /etc/resolv.conf) >"$1/egress.nft" || fail 'shipkeep.slice has no cgroup.'
  nft --check --file "$1/egress.nft" || fail 'nftables cannot load the egress guard of the Docker daemon.'
  install -m 0644 "$1/egress.nft" /etc/shipkeep-egress.nft
  # nftables.service applies the operator's ruleset and the guard in one transaction.
  printf 'include "/etc/nftables.conf"\ninclude "/etc/shipkeep-egress.nft"\n' >"$1/nftables.nft"
  printf 'flush ruleset\ninclude "/etc/shipkeep-egress.nft"\n' >"$1/nftables-stop.nft"
  install -m 0644 "$1/nftables.nft" /etc/shipkeep-nftables.nft
  install -m 0644 "$1/nftables-stop.nft" /etc/shipkeep-nftables-stop.nft
  install -d -m 0755 /etc/systemd/system/docker.service.d /etc/systemd/system/nftables.service.d
  cat > /etc/systemd/system/nftables.service.d/shipkeep-egress.conf <<'UNIT'
[Unit]
Requires=shipkeep.slice
After=shipkeep.slice
[Service]
ExecStart=
ExecStart=/usr/sbin/nft --file /etc/shipkeep-nftables.nft
ExecReload=
ExecReload=/usr/sbin/nft --file /etc/shipkeep-nftables.nft
ExecStop=
ExecStop=/usr/sbin/nft --file /etc/shipkeep-nftables-stop.nft
UNIT
  # Docker runs in the slice. It loads the guard before dockerd starts, for a server whose
  # nftables.service is not enabled (Ubuntu's default).
  cat > /etc/systemd/system/docker.service.d/shipkeep-egress.conf <<UNIT
[Unit]
Requires=shipkeep.slice
After=shipkeep.slice shipkeep-egress.service
Wants=shipkeep-egress.service
[Service]
Slice=shipkeep.slice
Environment=HTTP_PROXY=$egress_proxy HTTPS_PROXY=$egress_proxy NO_PROXY= http_proxy=$egress_proxy https_proxy=$egress_proxy no_proxy=
ExecStartPre=/usr/sbin/nft --file /etc/shipkeep-egress.nft
UNIT
  chmod 0644 /etc/systemd/system/{docker,nftables}.service.d/shipkeep-egress.conf
  systemctl daemon-reload
  if systemctl is-active --quiet nftables; then systemctl reload nftables; fi
  systemctl enable --now shipkeep-egress
  # Docker reports its proxy settings whether or not anything listens there: wait for the proxy.
  for attempt in {1..20}; do
    if systemctl is-active --quiet shipkeep-egress && [[ -n $(ss -H -ltn 'src = 127.0.0.1 and sport = :7480') ]]; then break; fi
    ((attempt < 20)) || fail 'The egress proxy did not start; inspect journalctl -u shipkeep-egress.'
    sleep 0.5
  done
  if docker_guarded "$slice"; then
    # A migration run again: Docker keeps running, with the guard as just written.
    nft --file /etc/shipkeep-egress.nft
  else
    printf 'Restarting Docker so that it pulls through the egress proxy; running containers restart with it.\n'
    systemctl restart docker
  fi
  [[ $(systemctl show --property ControlGroup --value docker.service) == "$slice/docker.service" ]] || fail 'Docker does not run in shipkeep.slice.'
  nft list table inet shipkeep_egress >/dev/null || fail 'The egress guard of the Docker daemon is not loaded.'
  curl --fail --silent --unix-socket /var/run/docker.sock http://localhost/v1.47/info | egress_proxies_applied || fail 'Docker does not report the egress proxy; check the proxy settings of its other drop-ins (systemctl cat docker).'
}
# Installs Caddy, the edge proxy, from upstream's signed repository: it needs security updates, and
# Ubuntu's universe build (2.6.2) neither guarantees them nor supports the socket mode the agent
# uses. $1 is a private work directory. Its own services stay disabled: shipkeep-caddy runs it.
install_caddy() {
  curl --fail --silent --show-error --proto '=https' --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$1/caddy.asc"
  single_signing_key "$1/caddy.asc" "$1/caddy.gpg" 65760C51EDEA2017CEA2CA15155B6D79CA56EA34 || fail 'Caddy signing key mismatch.' # gitleaks:allow (public signing-key fingerprint)
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$1/caddy.gpg" /etc/apt/keyrings/shipkeep-caddy.gpg
  cat > /etc/apt/sources.list.d/shipkeep-caddy.sources <<REPO
Types: deb
URIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian
Suites: any-version
Components: main
Signed-By: /etc/apt/keyrings/shipkeep-caddy.gpg
REPO
  chmod 0644 /etc/apt/sources.list.d/shipkeep-caddy.sources
  apt-get update -qq </dev/null
  # Prevent the package's default HTTP listener from starting during installation.
  systemctl mask --runtime caddy.service caddy-api.service
  apt-get install -y --no-install-recommends caddy </dev/null
  systemctl disable caddy.service caddy-api.service
  systemctl unmask --runtime caddy.service caddy-api.service
}
# Installs the builder, stopped (ADR 0030): its packages, the pinned BuildKit, the shipkeep-build
# account with its subordinate ids, its configuration and its units. The agent's account joins
# its group, for the socket. $1 is a private work directory. A migration runs it again: what is
# there already is kept. start_builder starts it, once the egress guard holds its rule.
prepare_builder() {
  local sha arch start
  case $(uname -m) in
    x86_64) sha=$buildkit_amd64_sha256 arch=amd64 ;;
    aarch64) sha=$buildkit_arm64_sha256 arch=arm64 ;;
    *) fail 'Unsupported architecture.' ;;
  esac
  apt-get install -y --no-install-recommends rootlesskit slirp4netns uidmap git </dev/null
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 600 --max-filesize 134217728 \
    "https://github.com/moby/buildkit/releases/download/$buildkit_version/buildkit-$buildkit_version.linux-$arch.tar.gz" -o "$1/buildkit.tar.gz"
  printf '%s  %s\n' "$sha" "$1/buildkit.tar.gz" | sha256sum --check --status || fail 'BuildKit checksum mismatch.'
  install -d -m 0700 "$1/buildkit"
  tar -xzf "$1/buildkit.tar.gz" -C "$1/buildkit" --no-same-owner --no-same-permissions bin/buildkitd bin/buildkit-runc
  install -d -m 0755 /usr/local/libexec/shipkeep-build
  install -m 0755 -o root -g root "$1/buildkit/bin/buildkitd" "$1/buildkit/bin/buildkit-runc" /usr/local/libexec/shipkeep-build/
  getent passwd shipkeep-build >/dev/null ||
    useradd --system --user-group --home-dir /var/lib/shipkeep-build --no-create-home --shell /usr/sbin/nologin shipkeep-build
  start=$(subordinate_start /etc/subuid /etc/subgid)
  grep -q '^shipkeep-build:' /etc/subuid || usermod --add-subuids "$start-$((start + 65535))" shipkeep-build
  grep -q '^shipkeep-build:' /etc/subgid || usermod --add-subgids "$start-$((start + 65535))" shipkeep-build
  usermod --append --groups shipkeep-build shipkeep
  install -d -m 0755 /etc/shipkeep-build
  buildkitd_config >"$1/buildkitd.toml"
  install -m 0644 "$1/buildkitd.toml" /etc/shipkeep-build/buildkitd.toml
  builder_slice_unit >"$1/shipkeep-build.slice"
  builder_unit >"$1/shipkeep-build.service"
  install -m 0644 "$1/shipkeep-build.slice" /etc/systemd/system/shipkeep-build.slice
  install -m 0644 "$1/shipkeep-build.service" /etc/systemd/system/shipkeep-build.service
  systemctl daemon-reload
}
# The builds' filesystem (#548): a fixed-size ext4 image, loop-mounted where the builder keeps its
# state and the agent its Railpack copies, so that a build that fills it fails without touching the
# disk of the applications and the control plane.
build_disk_image=/var/lib/shipkeep-build.img
build_disk_mount=/var/lib/shipkeep-build
# Its size in GiB: $2 when given (5 to 4096), else a fifth of the filesystem of /var/lib, whose size
# in bytes is $1, between 10 and 100 GiB.
build_disk_gib() {
  local gib
  if [[ -n ${2:-} ]]; then
    [[ $2 =~ ^[1-9][0-9]{0,3}$ ]] && (($2 >= 5 && $2 <= 4096)) || return 1
    printf '%s\n' "$2"
    return 0
  fi
  [[ $1 =~ ^[0-9]+$ ]] || return 1
  gib=$(($1 / 5 / 1073741824))
  ((gib >= 10)) || gib=10
  ((gib <= 100)) || gib=100
  printf '%s\n' "$gib"
}
build_disk_unit() {
  cat <<UNIT
[Unit]
Description=Shipkeep builds' filesystem
[Mount]
What=$build_disk_image
Where=$build_disk_mount
Type=ext4
Options=loop,nodev,noatime,nodiscard
[Install]
WantedBy=local-fs.target
UNIT
}
# Makes the builds' filesystem once, with the builder stopped, and mounts it: of $1 GiB when given,
# else of the default size. An existing one is kept, whatever its size, and so is a filesystem the
# operator mounted there before the first run. What the builder kept before is cache, and goes.
prepare_build_disk() {
  local unit size='' available own=''
  unit=$(systemd-escape --path --suffix=mount "$build_disk_mount")
  # An image an interrupted run allocated is never in use: it goes first, so that its space counts.
  rm -f -- "$build_disk_image.new"
  # Refused before anything stops: the builder goes on as it was.
  if [[ ! -e $build_disk_image && ! -e /etc/systemd/system/$unit ]] && mountpoint -q "$build_disk_mount"; then
    own=yes
    printf 'The builds use the filesystem mounted at %s.\n' "$build_disk_mount"
  elif [[ ! -e $build_disk_image ]]; then
    size=$(build_disk_gib "$(df --output=size -B1 /var/lib | tail -n 1)" "$1") || fail 'Cannot read the size of /var/lib.'
    available=$(df --output=avail -B1 /var/lib | tail -n 1)
    [[ $available =~ ^[0-9]+$ ]] || fail 'Cannot read the free space of /var/lib.'
    ((available >= (size + 5) * 1073741824)) ||
      fail "The builds need ${size} GiB of their own and 5 GiB to spare on /var/lib; pass a smaller --build-disk (5 GiB at least)."
  elif [[ -n $1 ]]; then
    printf 'The builds filesystem exists already (%s): --build-disk applies to a new one only.\n' "$build_disk_image"
  fi
  systemctl stop shipkeep-build 2>/dev/null || true
  if [[ -n $size ]]; then
    if ! mountpoint -q "$build_disk_mount"; then rm -rf -- "$build_disk_mount/buildkit"; fi
    # Its blocks are taken on /var/lib now, and stay taken: a discard at formatting, or the
    # zeroing of inode tables after the first mount, would punch holes in the image, and a build
    # would then take the server's disk as it writes. The tables are zeroed at formatting instead.
    if ! fallocate -l "${size}G" "$build_disk_image.new" || ! chmod 0600 "$build_disk_image.new" ||
      ! mkfs.ext4 -q -F -m 0 -E nodiscard,lazy_itable_init=0,lazy_journal_init=0 -L shipkeep-build "$build_disk_image.new"; then
      rm -f -- "$build_disk_image.new"
      fail 'Cannot make the builds filesystem.'
    fi
    mv -- "$build_disk_image.new" "$build_disk_image"
  fi
  if [[ -z $own ]]; then
    install -d -m 0755 "$build_disk_mount"
    build_disk_unit >"/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
    systemctl daemon-reload
    systemctl enable --now --quiet "$unit"
  fi
  mountpoint -q "$build_disk_mount" || fail "The builds filesystem did not mount; inspect journalctl -u $unit."
  chown shipkeep-build:shipkeep-build "$build_disk_mount"
  chmod 0750 "$build_disk_mount"
  install -d -o shipkeep -g shipkeep -m 0700 "$build_disk_mount/exports"
}
# Starts the builder, or restarts it on a migration, and waits for its socket.
start_builder() {
  local attempt
  systemctl enable shipkeep-build
  systemctl restart shipkeep-build
  for attempt in {1..60}; do
    [[ -S /run/shipkeep-build/buildkitd.sock ]] && return 0
    ((attempt < 60)) || fail 'The builder did not start; inspect journalctl -u shipkeep-build.'
    sleep 0.5
  done
}
# The checks source this file for the functions above, and stop here.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
control_plane='' fingerprint='' origin='' amd64='' arm64='' local_control_plane='' agent_file='' control_plane_only='' migrate='' build_disk=''
while (($#)); do
  (($# >= 2)) || fail 'Missing option value.'
  case "$1" in
    --control-plane) control_plane=$2 ;;
    --ca-fingerprint) fingerprint=$2 ;;
    --origin) origin=$2 ;;
    --amd64-sha256) amd64=$2 ;;
    --arm64-sha256) arm64=$2 ;;
    # Set by the control plane installer on a single machine (ADR 0021): the control plane's HTTP
    # address on loopback, and the agent binary it took from its own image (checked like a download).
    --local-control-plane) local_control_plane=$2 ;;
    --agent-file) agent_file=$2 ;;
    # Set by the control plane installer on its own machine when applications run elsewhere
    # (ADR 0028): an agent only, with no Caddy, egress proxy or application of its own.
    --control-plane-only) control_plane_only=$2 ;;
    # Brings a server set up by an earlier version of this installer to the current layout, and
    # keeps its identity, journal, applications and Caddy state (#490, ADR 0028).
    --migrate) migrate=$2 ;;
    # The size in GiB of the builds' filesystem (#548): a fifth of the disk by default.
    --build-disk) build_disk=$2 ;;
    *) fail 'Unknown option.' ;;
  esac
  shift 2
done
[[ $control_plane =~ ^([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$ ]] || fail 'Invalid gateway address.'
port=${control_plane##*:}
((10#$port > 0 && 10#$port <= 65535)) || fail 'Invalid gateway port.'
[[ $fingerprint =~ ^sha256:[a-f0-9]{64}$ && $amd64 =~ ^[a-f0-9]{64}$ && $arm64 =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid SHA-256 pin.'
[[ $origin =~ ^https://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?$ ]] || fail 'An HTTPS control-plane origin is required.'
[[ -z $local_control_plane ]] || valid_local_control_plane "$local_control_plane" || fail 'Invalid local control plane address: 127.0.0.1 and a port are required.'
[[ -z $agent_file || ($agent_file =~ ^/[A-Za-z0-9._/-]+$ && -f $agent_file && ! -L $agent_file) ]] || fail 'Invalid agent file: an absolute path to a regular file is required.'
[[ -z $local_control_plane || -n $agent_file ]] || fail 'A single machine installs the agent of its control plane image: pass --agent-file.'
[[ -z $control_plane_only || $control_plane_only == yes ]] || fail 'Invalid --control-plane-only: yes is the only value.'
[[ -z $control_plane_only || -z $local_control_plane ]] || fail 'A control-plane-only machine runs no application: give --local-control-plane on a single machine only.'
[[ -z $control_plane_only || -n $agent_file ]] || fail 'A control plane machine installs the agent of its control plane image: pass --agent-file.'
[[ -z $migrate || $migrate == yes ]] || fail 'Invalid --migrate: yes is the only value.'
if [[ -n $build_disk ]]; then build_disk_gib 0 "$build_disk" >/dev/null || fail 'Invalid --build-disk: a size in GiB, from 5 to 4096.'; fi
[[ -z $migrate || -z $local_control_plane$agent_file$control_plane_only ]] || fail 'Only a server for applications migrates: a control plane machine was set up by its own installer, with the current layout.'
# The control plane's name, the host of the gateway address, is the name its route serves.
control_plane_host=${control_plane%:*}
((EUID == 0)) || fail 'Run with sudo.'
[[ -d /run/systemd/system ]] || fail 'A systemd host is required.'
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'This installer supports Ubuntu 24.04.'
case $(uname -m) in x86_64) digest=$amd64 ;; aarch64) digest=$arm64 ;; *) fail 'Unsupported architecture.' ;; esac
if [[ -n $migrate ]]; then
  # Only a server this installer set up for applications, from 0.1.0-alpha.1 on, and nothing else:
  # every check runs before the first change, and anything unexpected is left for the operator.
  for account in shipkeep shipkeep-caddy; do
    [[ $(id -gn "$account" 2>/dev/null) == shipkeep ]] || fail "No $account account in the shipkeep group: this is not a Shipkeep server. Install it without --migrate."
  done
  id -nG shipkeep | tr ' ' '\n' | grep -qx docker || fail 'The shipkeep account is not in the docker group; reconcile it manually.'
  if getent passwd shipkeep-egress >/dev/null; then
    [[ $(id -gn shipkeep-egress) == shipkeep-egress ]] || fail 'The shipkeep-egress account is not in its own group; reconcile it manually.'
  elif getent group shipkeep-egress >/dev/null; then
    fail 'A shipkeep-egress group exists without its account; reconcile it manually.'
  fi
  if getent passwd shipkeep-build >/dev/null; then
    [[ $(id -gn shipkeep-build) == shipkeep-build ]] || fail 'The shipkeep-build account is not in its own group; reconcile it manually.'
    ! id -nG shipkeep-build | tr ' ' '\n' | grep -qx docker || fail 'The shipkeep-build account is in the docker group; reconcile it manually.'
  elif getent group shipkeep-build >/dev/null; then
    fail 'A shipkeep-build group exists without its account; reconcile it manually.'
  fi
  for path in /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep/bin; do
    [[ -d $path && ! -L $path && $(stat -c %U:%G -- "$path") == shipkeep:shipkeep ]] || fail "$path is not the agent's directory; reconcile it manually."
  done
  for path in /etc/shipkeep/agent.yaml /var/lib/shipkeep/bin/shipkeep-agent /etc/shipkeep-caddy.json /etc/tmpfiles.d/shipkeep.conf /usr/bin/caddy /etc/apt/sources.list.d/shipkeep-caddy.sources; do
    [[ -f $path && ! -L $path ]] || fail "$path is missing: this is not a server this installer set up."
  done
  layout=$(agent_unit_layout /etc/systemd/system/shipkeep-agent.service) || fail 'shipkeep-agent.service is not the unit an installer wrote; reconcile it manually.'
  [[ -f /etc/systemd/system/shipkeep-caddy.service && ! -L /etc/systemd/system/shipkeep-caddy.service && $(</etc/systemd/system/shipkeep-caddy.service) == "$(caddy_unit)" ]] ||
    fail 'shipkeep-caddy.service is not the unit an installer wrote; reconcile it manually.'
  for path in /etc/systemd/system/shipkeep-agent.service.d /etc/systemd/system/shipkeep-caddy.service.d; do
    [[ ! -e $path && ! -L $path ]] || fail "$path changes a Shipkeep unit; reconcile it manually."
  done
  [[ ! -e /etc/systemd/system/shipkeep-workloads.slice ]] || fail 'This machine also hosts the control plane, whose installer set it up with the current layout: there is nothing to migrate.'
  server_config_of /etc/shipkeep/agent.yaml "$control_plane" "$fingerprint" ||
    fail "/etc/shipkeep/agent.yaml names another control plane or CA than this command, or a control plane machine. Run the command that this server's control plane shows."
  # What an earlier migration or a current installation wrote is a regular file, rewritten below.
  for path in /usr/local/libexec/shipkeep-egress /etc/shipkeep-egress.nft /etc/shipkeep-nftables.nft /etc/shipkeep-nftables-stop.nft /etc/systemd/system/shipkeep.slice /etc/systemd/system/shipkeep-egress.service /etc/systemd/system/docker.service.d/shipkeep-egress.conf /etc/systemd/system/nftables.service.d/shipkeep-egress.conf /etc/shipkeep-build/buildkitd.toml /usr/local/libexec/shipkeep-build/buildkitd /usr/local/libexec/shipkeep-build/buildkit-runc /etc/systemd/system/shipkeep-build.service /etc/systemd/system/shipkeep-build.slice; do
    [[ ! -L $path && (! -e $path || -f $path) ]] || fail "$path is not a regular file; reconcile it manually."
  done
  # The builds' filesystem of an earlier migration or installation (#548) is kept as it is.
  for path in "$build_disk_image" "/etc/systemd/system/$(systemd-escape --path --suffix=mount "$build_disk_mount")"; do
    [[ ! -L $path && (! -e $path || -f $path) ]] || fail "$path is not a regular file; reconcile it manually."
  done
  # Its upgrade guard would put the previous binary back over the one installed here.
  if [[ -e /var/lib/shipkeep/upgrade.json ]] && grep -q '"state":"pending"' /var/lib/shipkeep/upgrade.json; then
    fail 'An agent upgrade is not confirmed yet. Wait until Servers shows it ended, then run this command again.'
  fi
  command -v ss >/dev/null || fail 'Install iproute2 before running this installer.'
  if ! systemctl is-active --quiet shipkeep-egress; then
    listeners=$(ss -H -ltn 'sport = :7480') || fail 'Cannot inspect TCP ports.'
    [[ -z $listeners ]] || fail 'Port 7480 is occupied; the egress proxy of the Docker daemon listens there.'
  fi
  curl --fail --silent --unix-socket /var/run/docker.sock http://localhost/v1.47/info -o /dev/null || fail 'Docker API 1.47 is unavailable.'
  work=$(mktemp -d /var/lib/shipkeep-install.XXXXXX)
  agent_stopped=''
  # Whatever stops the migration, the agent runs again: the old one, or the new one under the old or
  # the new unit, which all run with what is on disk at that point.
  # shellcheck disable=SC2329 # run by the EXIT trap below
  migration_cleanup() {
    rm -rf -- "$work"
    if [[ -n $agent_stopped ]]; then systemctl start shipkeep-agent || true; fi
  }
  trap migration_cleanup EXIT
  export DEBIAN_FRONTEND=noninteractive
  curl --fail --silent --show-error --proto '=https' --max-time 300 --max-filesize 50331648 "$origin/install/agent-$digest.bin" -o "$work/agent"
  printf '%s  %s\n' "$digest" "$work/agent" | sha256sum --check --status || fail 'Agent checksum mismatch.'
  chmod 0700 "$work/agent"
  "$work/agent" --validate --config /etc/shipkeep/agent.yaml >/dev/null || fail 'The new agent refuses /etc/shipkeep/agent.yaml (see above); nothing was changed.'
  # Changes start here. Each step leaves a server that runs: the old agent, or the new one under
  # the old or the guarded unit, Docker with or without the egress proxy. Running this again goes on.
  prepare_egress "$work"
  # The builder (ADR 0030), stopped until the guard holds its rule; the agent restarts below in
  # its group, for the socket.
  prepare_builder "$work"
  prepare_build_disk "$build_disk"
  getent passwd shipkeep-egress >/dev/null || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin shipkeep-egress
  install_guard "$work"
  if systemctl is-active --quiet shipkeep-egress; then systemctl restart shipkeep-egress; fi
  # Docker's restart below gives containers new addresses. The routes an agent of 0.1.0-alpha.3 or
  # earlier wrote have no record to follow them (ADR 0017): they are recorded first, while each
  # container still has its address, with the agent stopped so that nothing changes them meanwhile.
  agent_stopped=yes
  systemctl stop shipkeep-agent
  # Railpack's work directory before the builds' filesystem (#548): what a cut build left there.
  rm -rf -- /var/lib/shipkeep/builds
  printf 'Recording the routes of this server before Docker restarts.\n'
  if ! setpriv --reuid=shipkeep --regid=shipkeep --init-groups -- /usr/local/libexec/shipkeep-egress adopt-routes --config /etc/shipkeep/agent.yaml; then
    fail 'Stopped before the agent and Docker changed: the agent runs as before. Deploy again each application named above (a restart since its route was written sent its traffic elsewhere, or none of its containers runs), then run this command again.'
  fi
  install -m 0755 -o shipkeep -g shipkeep "$work/agent" /var/lib/shipkeep/bin/.shipkeep-agent.migrate
  mv -fT /var/lib/shipkeep/bin/.shipkeep-agent.migrate /var/lib/shipkeep/bin/shipkeep-agent
  # The unit waits for the new agent's READY, which the old agent never sends: binary first.
  agent_unit >"$work/agent.service"
  install -m 0644 "$work/agent.service" /etc/systemd/system/.shipkeep-agent.service.migrate
  mv -fT /etc/systemd/system/.shipkeep-agent.service.migrate /etc/systemd/system/shipkeep-agent.service
  systemctl daemon-reload
  systemctl start shipkeep-agent || fail 'The new agent did not start; inspect journalctl -u shipkeep-agent, then run this command again.'
  agent_stopped=''
  # Restarts Docker unless it already pulls through the proxy; the agent restarts with it, and its
  # first pass moves each recorded route to its container's new address.
  install_egress "$work"
  start_builder
  # Docker's restart restarts the agent too: it may still be starting.
  for attempt in {1..120}; do
    systemctl is-active --quiet shipkeep-agent && break
    ((attempt < 120)) || fail 'The agent did not come back after Docker; inspect journalctl -u shipkeep-agent, then run this command again.'
    sleep 1
  done
  printf 'Migrated (from the %s layout). Refresh Servers to verify ready; the agent can now be upgraded.\n' "$layout"
  exit 0
fi
for path in /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep-caddy /run/shipkeep /etc/shipkeep-caddy.json /etc/shipkeep-egress.nft /etc/shipkeep-nftables.nft /etc/shipkeep-nftables-stop.nft /etc/systemd/system/shipkeep.slice /etc/systemd/system/shipkeep-workloads.slice /usr/local/libexec/shipkeep-egress /etc/systemd/system/shipkeep-agent.service /etc/systemd/system/shipkeep-caddy.service /etc/systemd/system/shipkeep-egress.service /etc/systemd/system/docker.service.d/shipkeep-egress.conf /etc/systemd/system/nftables.service.d/shipkeep-egress.conf /etc/tmpfiles.d/shipkeep.conf /etc/shipkeep-build /var/lib/shipkeep-build /run/shipkeep-build /usr/local/libexec/shipkeep-build /etc/systemd/system/shipkeep-build.service /etc/systemd/system/shipkeep-build.slice "$build_disk_image" "/etc/systemd/system/$(systemd-escape --path --suffix=mount "$build_disk_mount")"; do
  # A disk the operator mounted for the builds, still empty, is theirs to give (#548).
  if [[ $path == "$build_disk_mount" ]] && mountpoint -q "$path" && [[ -z $(find "$path" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit) ]]; then continue; fi
  [[ ! -e $path && ! -L $path ]] || fail 'Existing Shipkeep installation; refusing to overwrite it. To bring a server an earlier version set up to the current layout, run the same command with --migrate yes.'
done
for account in shipkeep shipkeep-caddy shipkeep-egress shipkeep-build; do
  ! getent passwd "$account" >/dev/null || fail 'An installation service account already exists.'
  ! getent group "$account" >/dev/null || fail 'An installation group already exists.'
done
if [[ -n $local_control_plane ]]; then
  # ADR 0021: the reservation needs room beside it, and memory protection needs both of these.
  (($(nproc) >= minimum_cpus)) || fail 'A single machine needs at least 2 CPUs; install the control plane and the applications on two machines.'
  memory=$(memory_total_bytes /proc/meminfo) || fail 'Cannot read the memory of this machine.'
  ((memory >= minimum_memory_bytes)) || fail 'A single machine needs at least 3 GiB of memory; install the control plane and the applications on two machines.'
  cgroup2_recursiveprot /proc/self/mounts || fail 'A single machine needs cgroup v2 mounted with memory_recursiveprot (systemd 247 or later).'
fi
command -v ss >/dev/null || fail 'Install iproute2 before running this installer.'
# The edge of a server: its Caddy on 80 and 443, and the egress proxy of its Docker daemon. A
# control plane machine has neither: its ports are the control plane's Caddy's.
if [[ -z $control_plane_only ]]; then
  listeners=$(ss -H -ltn '( sport = :80 or sport = :443 )') || fail 'Cannot inspect TCP ports.'
  [[ -z $listeners ]] || fail 'Ports 80/443 are occupied.'
  listeners=$(ss -H -lun 'sport = :443') || fail 'Cannot inspect UDP ports.'
  [[ -z $listeners ]] || fail 'Port 443 is occupied.'
  listeners=$(ss -H -ltn 'sport = :7480') || fail 'Cannot inspect TCP ports.'
  [[ -z $listeners ]] || fail 'Port 7480 is occupied; the egress proxy of the Docker daemon listens there.'
  [[ ! -e /usr/bin/caddy && ! -e /etc/apt/sources.list.d/shipkeep-caddy.sources && ! -e /etc/apt/keyrings/shipkeep-caddy.gpg && ! -e /etc/apt/keyrings/shipkeep-caddy.asc ]] || fail 'Caddy is already installed; reconcile it manually.'
  for service in caddy.service caddy-api.service; do
    if systemctl is-active --quiet "$service" || systemctl is-enabled --quiet "$service"; then fail 'Existing Caddy service; reconcile it manually.'; fi
  done
fi
work=$(mktemp -d /var/lib/shipkeep-install.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
# Never consume the token until package installation and validation have succeeded.
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  for package in docker.io podman-docker containerd runc; do
    ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || fail 'Conflicting Docker packages; reconcile them manually.'
  done
  install_docker_packages /etc/apt
else
  apt-get update -qq </dev/null
  apt-get install -y --no-install-recommends ca-certificates curl gnupg </dev/null
fi
systemctl enable --now docker
# The agent pins Docker API 1.47. Do not silently replace an incompatible existing daemon.
curl --fail --silent --unix-socket /var/run/docker.sock http://localhost/v1.47/info -o /dev/null || fail 'Docker API 1.47 is unavailable.'
if [[ -n $local_control_plane ]]; then
  # With the cgroupfs driver, CgroupParent is a plain path and no slice would hold the containers.
  [[ $(docker info --format '{{.CgroupDriver}}') == systemd ]] || fail "A single machine needs Docker's systemd cgroup driver."
fi
if [[ -z $control_plane_only ]]; then
  # Every pull goes through the egress proxy, and a guard keeps the daemon off loopback (ADR 0023).
  prepare_egress "$work"
  install_caddy "$work"
fi
if [[ -n $agent_file ]]; then
  install -m 0600 -- "$agent_file" "$work/agent"
else
  curl --fail --silent --show-error --proto '=https' --max-time 300 --max-filesize 50331648 "$origin/install/agent-$digest.bin" -o "$work/agent"
fi
printf '%s  %s\n' "$digest" "$work/agent" | sha256sum --check --status || fail 'Agent checksum mismatch.'
cat > "$work/agent.yaml" <<CONFIG
control_plane:
  address: '$control_plane'
  ca_fingerprint: '$fingerprint'
  join_token_file: /etc/shipkeep/join-token
CONFIG
if [[ -n $local_control_plane ]]; then
  # ADR 0021: the agent connects over loopback and still verifies the public name, keeps the control
  # plane's route in this node's Caddy, reports the reservation, and puts applications in their
  # slice, first in the kernel's kill order.
  cat >> "$work/agent.yaml" <<CONFIG
  connect: '127.0.0.1:${control_plane##*:}'
  route:
    host: '$control_plane_host'
    upstream: '$local_control_plane'
node:
  role: control-plane
  reservation:
    cpu_millis: $reserved_cpu_millis
    memory_bytes: $reserved_memory_bytes
docker:
  workloads_slice: shipkeep-workloads.slice
  workloads_oom_score_adj: 1000
CONFIG
elif [[ -n $control_plane_only ]]; then
  # ADR 0028: the agent of the control plane's own machine connects over loopback and still
  # verifies the public name. Its role keeps applications off this machine.
  cat >> "$work/agent.yaml" <<CONFIG
  connect: '127.0.0.1:${control_plane##*:}'
node:
  role: control-plane-only
CONFIG
fi
chmod 0700 "$work/agent"
"$work/agent" --validate --config "$work/agent.yaml"
printf 'Join token (input hidden; paste it, then Enter): ' >&2
unset token
IFS= read -r -s -n 44 token || true
printf '\n' >&2
[[ $token =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'Invalid join token.'
groupadd --system shipkeep
useradd --system --gid shipkeep --groups docker --home-dir /var/lib/shipkeep --no-create-home --shell /usr/sbin/nologin shipkeep
if [[ -z $control_plane_only ]]; then
  useradd --system --gid shipkeep --home-dir /var/lib/shipkeep-caddy --no-create-home --shell /usr/sbin/nologin shipkeep-caddy
  useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin shipkeep-egress
fi
install -d -m 0700 -o shipkeep -g shipkeep /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep/bin
install -m 0755 -o shipkeep -g shipkeep "$work/agent" /var/lib/shipkeep/bin/shipkeep-agent
install -m 0600 -o shipkeep -g shipkeep "$work/agent.yaml" /etc/shipkeep/agent.yaml
printf '%s' "$token" > /etc/shipkeep/join-token
unset token
chown shipkeep:shipkeep /etc/shipkeep/join-token
chmod 0600 /etc/shipkeep/join-token
printf 'd /run/shipkeep 0770 shipkeep shipkeep -\n' > /etc/tmpfiles.d/shipkeep.conf
systemd-tmpfiles --create /etc/tmpfiles.d/shipkeep.conf
chmod 0644 /etc/tmpfiles.d/shipkeep.conf
if [[ -n $control_plane_only ]]; then
  agent_unit control-plane-only >/etc/systemd/system/shipkeep-agent.service
  chmod 0644 /etc/systemd/system/shipkeep-agent.service
  # The upgrade guard's copy only: no egress proxy, since this machine pulls no application image.
  install_guard "$work"
else
  printf '{"admin":{"listen":"unix//run/shipkeep/caddy-admin.sock|0660","origins":["caddy"]}}\n' > /etc/shipkeep-caddy.json
  chmod 0644 /etc/shipkeep-caddy.json
  caddy_unit >/etc/systemd/system/shipkeep-caddy.service
  agent_unit >/etc/systemd/system/shipkeep-agent.service
  chmod 0644 /etc/systemd/system/shipkeep-{agent,caddy}.service
  # The builder (ADR 0030) starts once the egress guard holds its rule.
  prepare_builder "$work"
  prepare_build_disk "$build_disk"
  install_egress "$work"
  start_builder
fi
if [[ -n $local_control_plane ]]; then
  workloads_slice_unit "$memory" >/etc/systemd/system/shipkeep-workloads.slice || fail 'No memory is left for applications beside the reservation.'
  chmod 0644 /etc/systemd/system/shipkeep-workloads.slice
  systemctl daemon-reload
  systemctl start shipkeep-workloads.slice
fi
if [[ -n $control_plane_only ]]; then
  systemctl daemon-reload
  systemctl enable --now shipkeep-agent
else
  systemctl enable --now shipkeep-caddy shipkeep-agent
fi
printf 'Services started. Refresh Servers to verify ready; inspect journalctl -u shipkeep-agent on failure.\n'
