#!/usr/bin/env bash
# Fresh Ubuntu 24.04 nodes only. Run the checksum-verified copy shown by the control plane.
set +ax
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fail() { printf 'shipkeep-install: %s\n' "$1" >&2; exit 1; }
control_plane='' fingerprint='' origin='' amd64='' arm64=''
while (($#)); do
  (($# >= 2)) || fail 'Missing option value.'
  case "$1" in
    --control-plane) control_plane=$2 ;;
    --ca-fingerprint) fingerprint=$2 ;;
    --origin) origin=$2 ;;
    --amd64-sha256) amd64=$2 ;;
    --arm64-sha256) arm64=$2 ;;
    *) fail 'Unknown option.' ;;
  esac
  shift 2
done
[[ $control_plane =~ ^([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$ ]] || fail 'Invalid gateway address.'
port=${control_plane##*:}
((10#$port > 0 && 10#$port <= 65535)) || fail 'Invalid gateway port.'
[[ $fingerprint =~ ^sha256:[a-f0-9]{64}$ && $amd64 =~ ^[a-f0-9]{64}$ && $arm64 =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid SHA-256 pin.'
[[ $origin =~ ^https://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?$ ]] || fail 'An HTTPS control-plane origin is required.'
((EUID == 0)) || fail 'Run with sudo.'
[[ -d /run/systemd/system ]] || fail 'A systemd host is required.'
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'This installer supports Ubuntu 24.04.'
case $(uname -m) in x86_64) digest=$amd64 ;; aarch64) digest=$arm64 ;; *) fail 'Unsupported architecture.' ;; esac
for path in /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep-caddy /run/shipkeep /etc/shipkeep-caddy.json /etc/systemd/system/shipkeep-agent.service /etc/systemd/system/shipkeep-caddy.service /etc/tmpfiles.d/shipkeep.conf; do
  [[ ! -e $path && ! -L $path ]] || fail 'Existing Shipkeep installation; refusing to overwrite it.'
done
for account in shipkeep shipkeep-caddy; do
  ! getent passwd "$account" >/dev/null || fail 'An installation service account already exists.'
  ! getent group "$account" >/dev/null || fail 'An installation group already exists.'
done
command -v ss >/dev/null || fail 'Install iproute2 before running this installer.'
listeners=$(ss -H -ltn '( sport = :80 or sport = :443 )') || fail 'Cannot inspect TCP ports.'
[[ -z $listeners ]] || fail 'Ports 80/443 are occupied.'
listeners=$(ss -H -lun 'sport = :443') || fail 'Cannot inspect UDP ports.'
[[ -z $listeners ]] || fail 'Port 443 is occupied.'
[[ ! -e /usr/bin/caddy && ! -e /etc/apt/sources.list.d/shipkeep-caddy.sources && ! -e /etc/apt/keyrings/shipkeep-caddy.asc ]] || fail 'Caddy is already installed; reconcile it manually.'
for service in caddy.service caddy-api.service; do
  if systemctl is-active --quiet "$service" || systemctl is-enabled --quiet "$service"; then fail 'Existing Caddy service; reconcile it manually.'; fi
done
work=$(mktemp -d /var/lib/shipkeep-install.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
# Never consume the token until package installation and validation have succeeded.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq </dev/null
apt-get install -y --no-install-recommends ca-certificates curl gnupg </dev/null
if ! command -v docker >/dev/null; then
  for package in docker.io podman-docker containerd runc; do
    ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || fail 'Conflicting Docker packages; reconcile them manually.'
  done
  [[ ! -e /etc/apt/sources.list.d/shipkeep-docker.sources && ! -e /etc/apt/keyrings/shipkeep-docker.asc ]] || fail 'Docker repository files already exist.'
  curl --fail --silent --show-error --proto '=https' --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
  key=$(gpg --batch --show-keys --with-colons "$work/docker.asc" | awk -F: '$1=="fpr" {print $10; exit}')
  [[ $key == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || fail 'Docker signing key mismatch.'
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$work/docker.asc" /etc/apt/keyrings/shipkeep-docker.asc
  cat > /etc/apt/sources.list.d/shipkeep-docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/shipkeep-docker.asc
REPO
  chmod 0644 /etc/apt/sources.list.d/shipkeep-docker.sources
  apt-get update -qq </dev/null
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io </dev/null
fi
systemctl enable --now docker
# The agent pins Docker API 1.47. Do not silently replace an incompatible existing daemon.
curl --fail --silent --unix-socket /var/run/docker.sock http://localhost/v1.47/info -o /dev/null || fail 'Docker API 1.47 is unavailable.'
# Upstream's signed repository: the edge proxy needs security updates, and Ubuntu's universe build
# (2.6.2) neither guarantees them nor supports the socket mode used below.
curl --fail --silent --show-error --proto '=https' --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$work/caddy.asc"
key=$(gpg --batch --show-keys --with-colons "$work/caddy.asc" | awk -F: '$1=="fpr" {print $10; exit}')
[[ $key == 65760C51EDEA2017CEA2CA15155B6D79CA56EA34 ]] || fail 'Caddy signing key mismatch.' # gitleaks:allow (public signing-key fingerprint)
install -d -m 0755 /etc/apt/keyrings
install -m 0644 "$work/caddy.asc" /etc/apt/keyrings/shipkeep-caddy.asc
cat > /etc/apt/sources.list.d/shipkeep-caddy.sources <<REPO
Types: deb
URIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian
Suites: any-version
Components: main
Signed-By: /etc/apt/keyrings/shipkeep-caddy.asc
REPO
chmod 0644 /etc/apt/sources.list.d/shipkeep-caddy.sources
apt-get update -qq </dev/null
# Prevent the package's default HTTP listener from starting during installation.
systemctl mask --runtime caddy.service caddy-api.service
apt-get install -y --no-install-recommends caddy </dev/null
systemctl disable caddy.service caddy-api.service
systemctl unmask --runtime caddy.service caddy-api.service
curl --fail --silent --show-error --proto '=https' --max-time 300 --max-filesize 50331648 "$origin/install/agent-$digest.bin" -o "$work/agent"
printf '%s  %s\n' "$digest" "$work/agent" | sha256sum --check --status || fail 'Agent checksum mismatch.'
cat > "$work/agent.yaml" <<CONFIG
control_plane:
  address: '$control_plane'
  ca_fingerprint: '$fingerprint'
  join_token_file: /etc/shipkeep/join-token
CONFIG
chmod 0700 "$work/agent"
"$work/agent" --validate --config "$work/agent.yaml"
printf 'Join token (input hidden; paste it, then Enter): ' >&2
unset token
IFS= read -r -s -n 44 token || true
printf '\n' >&2
[[ $token =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'Invalid join token.'
groupadd --system shipkeep
useradd --system --gid shipkeep --groups docker --home-dir /var/lib/shipkeep --no-create-home --shell /usr/sbin/nologin shipkeep
useradd --system --gid shipkeep --home-dir /var/lib/shipkeep-caddy --no-create-home --shell /usr/sbin/nologin shipkeep-caddy
install -d -m 0700 -o shipkeep -g shipkeep /etc/shipkeep /var/lib/shipkeep /var/lib/shipkeep/bin
install -m 0755 -o shipkeep -g shipkeep "$work/agent" /var/lib/shipkeep/bin/shipkeep-agent
install -m 0600 -o shipkeep -g shipkeep "$work/agent.yaml" /etc/shipkeep/agent.yaml
printf '%s' "$token" > /etc/shipkeep/join-token
unset token
chown shipkeep:shipkeep /etc/shipkeep/join-token
chmod 0600 /etc/shipkeep/join-token
printf 'd /run/shipkeep 0770 shipkeep shipkeep -\n' > /etc/tmpfiles.d/shipkeep.conf
systemd-tmpfiles --create /etc/tmpfiles.d/shipkeep.conf
printf '{"admin":{"listen":"unix//run/shipkeep/caddy-admin.sock|0660","origins":["caddy"]}}\n' > /etc/shipkeep-caddy.json
chmod 0644 /etc/shipkeep-caddy.json /etc/tmpfiles.d/shipkeep.conf
cat > /etc/systemd/system/shipkeep-caddy.service <<'UNIT'
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
cat > /etc/systemd/system/shipkeep-agent.service <<'UNIT'
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
chmod 0644 /etc/systemd/system/shipkeep-{agent,caddy}.service
systemctl daemon-reload
systemctl enable --now shipkeep-caddy shipkeep-agent
printf 'Services started. Refresh Servers to verify ready; inspect journalctl -u shipkeep-agent on failure.\n'
