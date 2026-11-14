#!/usr/bin/env bash
# Installs the Shipkeep control plane on this machine with Docker Compose.
# Run it from a release bundle (shipkeep-control-plane_<version>.tar.gz), where it sits next to
# compose.yml, Caddyfile and the image file. docs/INSTALL.md describes what it does.
set +ax
set -euo pipefail
export LC_ALL=C

fail() {
  printf 'shipkeep-install: %s\n' "$1" >&2
  exit 1
}

valid_directory() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]{1,200}$ && $1 != */ && $1 != *//* && ! $1 =~ (^|/)\.\.?(/|$) ]]
}
valid_domain() {
  ((${#1} <= 253)) && [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}
valid_smtp_host() {
  ((${#1} <= 253)) && [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]]
}
valid_port() {
  [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 > 0 && 10#$1 <= 65535))
}
valid_address() {
  ((${#1} <= 254)) && [[ $1 =~ ^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}
# A login or a password: one line of at most $2 bytes, without control characters.
valid_credential() {
  ((${#1} <= $2)) && [[ $1 != *[[:cntrl:]]* ]]
}

# One line of the settings file. Docker Compose reads a double-quoted value literally once
# backslashes, double quotes and dollar signs are escaped.
env_line() {
  local value=$2
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  printf '%s="%s"\n' "$1" "$value"
}

write_env() {
  {
    printf '# Written by the Shipkeep installer. Keep this file private: it holds the database passwords.\n'
    env_line SHIPKEEP_IMAGE "$image"
    env_line SHIPKEEP_DOMAIN "$domain"
    env_line POSTGRES_ADMIN_PASSWORD "$admin_password"
    env_line POSTGRES_APP_PASSWORD "$app_password"
    env_line SMTP_HOST "$smtp_host"
    env_line SMTP_PORT "$smtp_port"
    env_line SMTP_FROM "$smtp_from"
    env_line SMTP_USER "$smtp_user"
    env_line SMTP_PASSWORD "$smtp_password"
  } >"$1"
}

# The release this bundle installs, by tag and digest.
read_image() {
  [[ -f $1 && ! -L $1 ]] || fail 'Run this installer from a release bundle: the image file is missing.'
  image=$(<"$1")
  [[ $image =~ ^[a-z0-9]([a-z0-9._/-]{0,198}[a-z0-9])?:[A-Za-z0-9._-]{1,128}@sha256:[a-f0-9]{64}$ ]] || fail 'The image file does not name a release by tag and digest.'
  [[ ${image##*:} != 0000000000000000000000000000000000000000000000000000000000000000 ]] || fail 'This bundle comes from a dry run: its image was never published.'
}

assert_no_installation() {
  local file
  for file in .env compose.yml Caddyfile; do
    [[ ! -e $1/$file && ! -L $1/$file ]] || fail "Existing installation in $1; refusing to overwrite it."
  done
}

# Sets the variable named by $1 from stdin, unless a flag already did. An invalid answer is asked
# again on a terminal, and ends the run otherwise.
ask() {
  local name=$1 question=$2 check=$3 error=$4 answer
  [[ -z ${!name} ]] || return 0
  while :; do
    printf '%s: ' "$question" >&2
    if ! IFS= read -r answer && [[ -z $answer ]]; then
      printf '\n' >&2
      fail "$error"
    fi
    if "$check" "$answer"; then
      printf -v "$name" '%s' "$answer"
      return 0
    fi
    # Not a terminal: nobody can answer again, and the question still waits for its line end.
    [[ -t 0 ]] || printf '\n' >&2
    [[ -t 0 ]] || fail "$error"
    printf '%s\n' "$error" >&2
  done
}

# Ubuntu 24.04 only, from Docker's own repository, with its signing key pinned (as the server
# installer does). Elsewhere the operator installs Docker.
install_docker() {
  local package key work
  # shellcheck source=/dev/null
  [[ -r /etc/os-release ]] && . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 && -d /run/systemd/system ]] || fail 'Docker is not installed. Install Docker Engine and its Compose plugin (https://docs.docker.com/engine/install/), then run this installer again.'
  for package in docker.io podman-docker containerd runc; do
    ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || fail 'Conflicting Docker packages; reconcile them manually.'
  done
  [[ ! -e /etc/apt/sources.list.d/shipkeep-docker.sources && ! -e /etc/apt/keyrings/shipkeep-docker.asc ]] || fail 'An earlier run left /etc/apt/sources.list.d/shipkeep-docker.sources or /etc/apt/keyrings/shipkeep-docker.asc: remove both, then run this installer again.'
  printf 'Installing Docker from its signed repository...\n'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null
  apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg </dev/null >/dev/null
  work=$(mktemp -d)
  curl --fail --silent --show-error --proto '=https' --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
  # Its own home, so that reading the key leaves nothing in root's.
  key=$(GNUPGHOME=$work gpg --batch --quiet --show-keys --with-colons "$work/docker.asc" | awk -F: '$1=="fpr" {print $10; exit}')
  [[ $key == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || fail 'Docker signing key mismatch.'
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$work/docker.asc" /etc/apt/keyrings/shipkeep-docker.asc
  rm -rf -- "$work"
  cat >/etc/apt/sources.list.d/shipkeep-docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/shipkeep-docker.asc
REPO
  chmod 0644 /etc/apt/sources.list.d/shipkeep-docker.sources
  apt-get update -qq </dev/null
  apt-get install -y -qq --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin </dev/null >/dev/null
  systemctl enable --quiet --now docker
}

# Asks the control plane, through Caddy, with certificate verification: it succeeds only once the
# certificate of the domain is issued. Over loopback, so that it does not depend on the route from
# this machine to its own public address.
https_answers() {
  docker compose exec -T control-plane node -e '
    const name = process.argv[1];
    const request = require("node:https").get(
      { host: "127.0.0.1", port: 443, servername: name, path: "/api/v1/health", headers: { host: name }, timeout: 8000 },
      (response) => process.exit(response.statusCode === 200 ? 0 : 1),
    );
    request.on("timeout", () => process.exit(1));
    request.on("error", () => process.exit(1));
  ' "$1" >/dev/null 2>&1
}

# Printed when the run stops after the settings file is written: its passwords must be kept.
unfinished() {
  ((!writing)) || printf 'shipkeep-install: the installation did not finish. Keep %s/.env: it holds the database passwords. Once the cause is fixed, finish with: cd %s && sudo docker compose up -d\n' "$directory" "$directory" >&2
}

main() {
  umask 077
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  local here file port volume listeners attempt=0 user_given=0
  directory=/opt/shipkeep writing=0
  domain='' smtp_host='' smtp_port='' smtp_from='' smtp_user='' smtp_password=''
  while (($#)); do
    (($# >= 2)) || fail 'Missing option value.'
    case "$1" in
      --dir) directory=$2 ;;
      --domain) domain=$2 ;;
      --smtp-host) smtp_host=$2 ;;
      --smtp-port) smtp_port=$2 ;;
      --smtp-from) smtp_from=$2 ;;
      --smtp-user) smtp_user=$2 user_given=1 ;;
      *) fail 'Unknown option. Options: --dir, --domain, --smtp-host, --smtp-port, --smtp-from, --smtp-user.' ;;
    esac
    shift 2
  done
  valid_directory "$directory" || fail 'Invalid directory: an absolute path is required.'
  [[ -z $domain ]] || valid_domain "$domain" || fail 'Invalid domain: a lowercase DNS name is required, for example shipkeep.example.com.'
  [[ -z $smtp_host ]] || valid_smtp_host "$smtp_host" || fail 'Invalid SMTP host.'
  [[ -z $smtp_port ]] || valid_port "$smtp_port" || fail 'Invalid SMTP port.'
  [[ -z $smtp_from ]] || valid_address "$smtp_from" || fail 'Invalid sender address.'
  valid_credential "$smtp_user" 254 || fail 'Invalid SMTP user.'

  # Everything up to the questions only reads: a refusal leaves the machine as it was.
  ((EUID == 0)) || fail 'Run with sudo.'
  [[ $(uname -s) == Linux ]] || fail 'A Linux machine is required.'
  case $(uname -m) in x86_64 | aarch64) ;; *) fail 'Unsupported architecture: the image is built for amd64 and arm64.' ;; esac
  here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  read_image "$here/image"
  for file in compose.yml Caddyfile; do
    [[ -f $here/$file && ! -L $here/$file ]] || fail "Run this installer from a release bundle: $file is missing."
  done
  assert_no_installation "$directory"
  if command -v docker >/dev/null; then
    docker info >/dev/null 2>&1 || fail 'Docker is installed, but its daemon does not answer.'
    docker compose version >/dev/null 2>&1 || fail 'The Docker Compose plugin is missing (https://docs.docker.com/compose/install/linux/).'
    # New passwords cannot open the database that an earlier installation left behind.
    for volume in shipkeep_postgres-data shipkeep_keys shipkeep_caddy-data shipkeep_caddy-config; do
      ! docker volume inspect "$volume" >/dev/null 2>&1 || fail "The Docker volume $volume of an earlier installation exists; refusing to reuse it."
    done
  fi
  command -v ss >/dev/null || fail 'Install iproute2 before running this installer.'
  for port in 80 443 7443; do
    listeners=$(ss -H -ltn "sport = :$port") || fail 'Cannot inspect TCP ports.'
    [[ -z $listeners ]] || fail "Port $port is already in use on this machine."
  done
  listeners=$(ss -H -lun 'sport = :443') || fail 'Cannot inspect UDP ports.'
  [[ -z $listeners ]] || fail 'UDP port 443 is already in use on this machine.'

  ask domain 'DNS name of the control plane, for example shipkeep.example.com' valid_domain 'A lowercase DNS name is required, for example shipkeep.example.com.'
  # Without its DNS record Caddy cannot obtain the certificate, and failed attempts are rate limited.
  if command -v getent >/dev/null; then
    getent ahosts "$domain" >/dev/null || fail "$domain does not resolve. Create its DNS record pointing at this machine, then run this installer again: nothing was changed."
  fi
  printf 'Accounts are confirmed by email: an SMTP account with implicit TLS (port 465 unless --smtp-port says otherwise) is required.\n' >&2
  ask smtp_host 'SMTP host' valid_smtp_host 'An SMTP host name is required.'
  [[ -n $smtp_port ]] || smtp_port=465
  ask smtp_from 'Sender address, for example shipkeep@example.com' valid_address 'A sender address is required.'
  if ((!user_given)); then
    printf 'SMTP user (empty when the server asks for no login): ' >&2
    if ! IFS= read -r smtp_user && [[ -z $smtp_user ]]; then
      printf '\n' >&2
      fail 'Missing SMTP user: pass --smtp-user, empty when the server asks for no login.'
    fi
    valid_credential "$smtp_user" 254 || fail 'Invalid SMTP user.'
  fi
  if [[ -n $smtp_user ]]; then
    printf 'SMTP password (input hidden): ' >&2
    IFS= read -r -s smtp_password || true
    printf '\n' >&2
    [[ -n $smtp_password ]] || fail 'An SMTP user needs a password.'
    valid_credential "$smtp_password" 4096 || fail 'Invalid SMTP password: a single line is required.'
  fi

  command -v docker >/dev/null || install_docker
  admin_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  app_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  [[ $admin_password =~ ^[a-f0-9]{64}$ && $app_password =~ ^[a-f0-9]{64}$ ]] || fail 'Cannot generate the database passwords.'
  trap unfinished EXIT
  writing=1
  # Only .env is private. An existing directory keeps its mode.
  [[ -d $directory ]] || install -d -m 0755 "$directory"
  install -m 0644 "$here/compose.yml" "$here/Caddyfile" "$directory/"
  write_env "$directory/.env.new"
  mv -- "$directory/.env.new" "$directory/.env"
  unset smtp_password admin_password app_password
  cd -- "$directory"
  printf 'Downloading %s...\n' "${image%%@*}"
  docker compose pull
  printf 'Starting the control plane...\n'
  docker compose up -d
  writing=0

  printf 'Waiting for the HTTPS certificate of %s...\n' "$domain"
  until https_answers "$domain"; do
    attempt=$((attempt + 1))
    if ((attempt >= 24)); then
      printf 'The control plane is running, but https://%s does not answer with a valid certificate yet.\n' "$domain" >&2
      printf 'Check that %s points at this machine and that ports 80 and 443 are reachable from the internet.\n' "$domain" >&2
      printf 'Caddy keeps trying by itself: do not run this installer again. Its reasons are in: cd %s && sudo docker compose logs caddy\n' "$directory" >&2
      exit 1
    fi
    sleep 5
  done
  printf '\nShipkeep is running at https://%s\n' "$domain"
  printf 'Open it and create your account: the confirmation code arrives by email.\n'
  printf 'The compose file and its settings are in %s. Keep .env private: it holds the database passwords.\n' "$directory"
  printf 'Back up the key-encryption key now: https://github.com/shipkeepdev/shipkeep/blob/main/docs/INSTALL.md#back-up-the-key-encryption-key\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
