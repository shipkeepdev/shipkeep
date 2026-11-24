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
# Prints the nftables guard of ADR 0023 for the cgroup $1 of shipkeep.slice, which holds the
# Docker daemon: its new connections to loopback are rejected, except to the egress proxy and to
# the name servers read on standard input, port 53. It fails for a cgroup that is not the slice's.
egress_guard() {
  local cgroup=$1 level server family
  [[ $cgroup =~ ^(/[A-Za-z0-9@._:-]+)*/shipkeep\.slice$ ]] || return 1
  level=${cgroup//[^\/]/}
  printf 'destroy table inet shipkeep_egress\n'
  printf 'table inet shipkeep_egress {\n'
  printf '  chain output {\n'
  printf '    type filter hook output priority filter; policy accept;\n'
  printf '    socket cgroupv2 level %d "%s" ct state new jump docker\n' "${#level}" "${cgroup#/}"
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
  printf '}\n'
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
ReadWritePaths=/etc/shipkeep /var/lib/shipkeep /run/shipkeep
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
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
  local attempt slice
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
  loopback_nameservers /etc/resolv.conf | egress_guard "$slice" >"$1/egress.nft" || fail 'shipkeep.slice has no cgroup.'
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
  printf 'Restarting Docker so that it pulls through the egress proxy; running containers restart with it.\n'
  systemctl restart docker
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
# The checks source this file for the functions above, and stop here.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
control_plane='' fingerprint='' origin='' amd64='' arm64='' local_control_plane='' agent_file='' control_plane_only=''
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
# The control plane's name, the host of the gateway address, is the name its route serves.
control_plane_host=${control_plane%:*}
((EUID == 0)) || fail 'Run with sudo.'
[[ -d /run/systemd/system ]] || fail 'A systemd host is required.'
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'This installer supports Ubuntu 24.04.'
case $(uname -m) in x86_64) digest=$amd64 ;; aarch64) digest=$arm64 ;; *) fail 'Unsupported architecture.' ;; esac
for path in /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep-caddy /run/shipkeep /etc/shipkeep-caddy.json /etc/shipkeep-egress.nft /etc/shipkeep-nftables.nft /etc/shipkeep-nftables-stop.nft /etc/systemd/system/shipkeep.slice /etc/systemd/system/shipkeep-workloads.slice /usr/local/libexec/shipkeep-egress /etc/systemd/system/shipkeep-agent.service /etc/systemd/system/shipkeep-caddy.service /etc/systemd/system/shipkeep-egress.service /etc/systemd/system/docker.service.d/shipkeep-egress.conf /etc/systemd/system/nftables.service.d/shipkeep-egress.conf /etc/tmpfiles.d/shipkeep.conf; do
  [[ ! -e $path && ! -L $path ]] || fail 'Existing Shipkeep installation; refusing to overwrite it.'
done
for account in shipkeep shipkeep-caddy shipkeep-egress; do
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
  install_egress "$work"
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
