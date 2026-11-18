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
# An email address the control plane accepts too (its rule is wider: more punctuation in the
# name). A name of words joined by single dots, then a domain of at least two labels.
valid_address() {
  local word='[A-Za-z0-9_%+-]+' label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
  ((${#1} <= 254)) && [[ $1 =~ ^($word(\.$word)*)@$label(\.$label)+$ ]] && ((${#BASH_REMATCH[1]} <= 64))
}
# A login or a password: one line of at most $2 bytes, without control characters.
valid_credential() {
  ((${#1} <= $2)) && [[ $1 != *[[:cntrl:]]* ]]
}
# The password of the first account: one line of 15 to 128 characters, counted as the control
# plane counts them (Unicode code points), so that it is not refused once the stack is started.
# This script runs in the C locale, where a length is a number of bytes: a code point is one byte
# that is not a UTF-8 continuation byte (10xxxxxx).
valid_owner_password() {
  local leading=${1//[$'\x80'-$'\xbf']/}
  ((${#leading} >= 15 && ${#leading} <= 128)) && [[ $1 != *[[:cntrl:]]* ]]
}

# Starts from this script's own variables. A name inherited from the environment stays exported
# when it is assigned: every child, Docker included, would receive the passwords kept under these
# names. And Docker Compose prefers a variable of the environment to the settings file and to the
# bundled compose file, which alone must decide what the installation runs with.
own_variables() {
  unset -v owner_password smtp_password admin_password app_password
  unset -v SHIPKEEP_IMAGE SHIPKEEP_DOMAIN POSTGRES_ADMIN_PASSWORD POSTGRES_APP_PASSWORD
  unset -v SMTP_HOST SMTP_PORT SMTP_FROM SMTP_USER SMTP_PASSWORD
  unset -v COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME COMPOSE_PROFILES
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
  # Never through a file or a link that is already there: it could lead the passwords elsewhere.
  set -o noclobber
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
  } >"$1" || fail "Cannot create $1."
  set +o noclobber
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
  for file in .env .env.new compose.yml Caddyfile; do
    [[ ! -e $1/$file && ! -L $1/$file ]] || fail "Existing installation in $1; refusing to overwrite it."
  done
}

# The directory and every directory above it must be root's alone to change, and none may be a
# link: whoever can change one of them could plant a file for Docker Compose to load, lead the
# passwords elsewhere, or swap the whole installation for another before it is used. Components
# that do not exist yet are created by root below a directory that passed.
assert_root_directory() {
  local path=/ part owner mode
  local -a parts
  IFS=/ read -r -a parts <<<"${1#/}"
  for part in '' "${parts[@]}"; do
    [[ -z $part ]] || path=${path%/}/$part
    [[ -e $path || -L $path ]] || return 0
    [[ ! -L $path ]] || fail "$path is a link: give the real path with --dir."
    [[ -d $path ]] || fail "$path exists and is not a directory."
    owner=$(stat -c %u -- "$path") mode=$(stat -c %a -- "$path")
    if [[ $owner != 0 ]] || ((8#$mode & 8#22)); then fail "$path must belong to root and be writable by root only."; fi
  done
}

# New passwords cannot open the database that an earlier installation left behind.
assert_no_volumes() {
  local volume
  for volume in shipkeep_postgres-data shipkeep_keys shipkeep_caddy-data shipkeep_caddy-config; do
    ! docker volume inspect "$volume" >/dev/null 2>&1 || fail "The Docker volume $volume of an earlier installation exists; refusing to reuse it."
  done
}

# Writes to $2 a keyring that holds the key with fingerprint $3 and nothing else, taken from the
# downloaded file $1. It fails unless that file holds exactly this one key: apt trusts every key
# of the keyring a repository names, so a second key in the download would be trusted too.
single_signing_key() {
  local home listed status=1
  home=$(mktemp -d)
  if gpg --homedir "$home" --batch --quiet --import "$1" 2>/dev/null; then
    listed=$(gpg --homedir "$home" --batch --quiet --with-colons --list-keys 2>/dev/null | awk -F: '$1=="pub" {keys++} $1=="fpr" && !first {first=$10} END {print keys ":" first}')
    if [[ $listed == "1:$3" ]] && gpg --homedir "$home" --batch --quiet --export "$3" >"$2" 2>/dev/null && [[ -s $2 ]]; then status=0; fi
  fi
  rm -rf -- "$home"
  return "$status"
}

# The bundled file only: Docker Compose would otherwise also load an override file found next to it.
compose() {
  docker compose --file compose.yml "$@"
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

# One line of a standard input that is not a terminal, into the variable named by $1, and not a
# byte more. It is read byte by byte because `read` drops a NUL byte without a word: the secret
# kept would then differ from the one given. Returns 2 for a NUL byte, 3 for a line too long.
read_piped_line() {
  local byte line=''
  while IFS= read -r -s -d '' -n 1 byte; do
    [[ -n $byte ]] || return 2
    [[ $byte != $'\n' ]] || break
    line+=$byte
    ((${#line} <= 4096)) || return 3
  done
  printf -v "$1" '%s' "$line"
}

# One secret line into the variable named by $1, never shown: typed on a terminal, or the next
# line of a pipe.
read_hidden() {
  if [[ -t 0 ]]; then
    IFS= read -r -s "$1" || true
  else
    read_piped_line "$1"
  fi
}

# Sets owner_password from stdin, never shown. A terminal is asked twice, and again after a
# mistake; a pipe gives its line once.
ask_owner_password() {
  local again status
  while :; do
    status=0
    printf 'Password of this account, 15 characters or more (input hidden): ' >&2
    read_hidden owner_password || status=$?
    printf '\n' >&2
    ((status != 2)) || fail 'The password holds a NUL byte: give it as one line of plain UTF-8 text.'
    if ((status)) || ! valid_owner_password "$owner_password"; then
      [[ -t 0 ]] || fail 'The first account needs a password of 15 to 128 characters.'
      printf 'Use between 15 and 128 characters.\n' >&2
      continue
    fi
    [[ -t 0 ]] || return 0
    printf 'The same password again (input hidden): ' >&2
    read_hidden again || true
    printf '\n' >&2
    [[ $again != "$owner_password" ]] || return 0
    printf 'The two passwords differ.\n' >&2
  done
}

# Creates the first account with the command line of the control plane (ADR 0020). The password
# goes on standard input: an argument or a variable could be read by other processes.
create_first_account() {
  printf '%s\n' "$owner_password" | compose run --rm --no-deps -T control-plane node main.js account create --email "$owner_email"
}

# Ubuntu 24.04 only, from Docker's own repository, with its signing key pinned (as the server
# installer does). Elsewhere the operator installs Docker.
install_docker() {
  local package work
  # shellcheck source=/dev/null
  [[ -r /etc/os-release ]] && . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 && -d /run/systemd/system ]] || fail 'Docker is not installed. Install Docker Engine and its Compose plugin (https://docs.docker.com/engine/install/), then run this installer again.'
  for package in docker.io podman-docker containerd runc; do
    ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || fail 'Conflicting Docker packages; reconcile them manually.'
  done
  [[ ! -e /etc/apt/sources.list.d/shipkeep-docker.sources && ! -e /etc/apt/keyrings/shipkeep-docker.gpg ]] || fail 'An earlier run left /etc/apt/sources.list.d/shipkeep-docker.sources or /etc/apt/keyrings/shipkeep-docker.gpg: remove both, then run this installer again.'
  printf 'Installing Docker from its signed repository...\n'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null
  apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg </dev/null >/dev/null
  work=$(mktemp -d)
  curl --fail --silent --show-error --proto '=https' --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o "$work/docker.asc"
  single_signing_key "$work/docker.asc" "$work/docker.gpg" 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 || fail 'Docker signing key mismatch.'
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$work/docker.gpg" /etc/apt/keyrings/shipkeep-docker.gpg
  rm -rf -- "$work"
  cat >/etc/apt/sources.list.d/shipkeep-docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/shipkeep-docker.gpg
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
  compose exec -T control-plane node -e '
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
  ((!writing)) || printf 'shipkeep-install: the installation did not finish. Keep %s/.env: it holds the database passwords. Once the cause is fixed, finish with: cd %s && sudo docker compose -f compose.yml up -d\n' "$directory" "$directory" >&2
}

main() {
  umask 077
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  local here file port listeners attempt=0 user_given=0
  own_variables
  directory=/opt/shipkeep writing=0
  domain='' owner_email='' owner_password=''
  smtp_host='' smtp_port='' smtp_from='' smtp_user='' smtp_password=''
  while (($#)); do
    (($# >= 2)) || fail 'Missing option value.'
    case "$1" in
      --dir) directory=$2 ;;
      --domain) domain=$2 ;;
      --email) owner_email=$2 ;;
      --smtp-host) smtp_host=$2 ;;
      --smtp-port) smtp_port=$2 ;;
      --smtp-from) smtp_from=$2 ;;
      --smtp-user) smtp_user=$2 user_given=1 ;;
      *) fail 'Unknown option. Options: --dir, --domain, --email, and for an installation that sends email --smtp-host, --smtp-port, --smtp-from, --smtp-user.' ;;
    esac
    shift 2
  done
  valid_directory "$directory" || fail 'Invalid directory: an absolute path is required.'
  [[ -z $domain ]] || valid_domain "$domain" || fail 'Invalid domain: a lowercase DNS name is required, for example shipkeep.example.com.'
  [[ -z $owner_email ]] || valid_address "$owner_email" || fail 'Invalid email address.'
  [[ -z $smtp_host ]] || valid_smtp_host "$smtp_host" || fail 'Invalid SMTP host.'
  [[ -z $smtp_port ]] || valid_port "$smtp_port" || fail 'Invalid SMTP port.'
  [[ -z $smtp_from ]] || valid_address "$smtp_from" || fail 'Invalid sender address.'
  valid_credential "$smtp_user" 254 || fail 'Invalid SMTP user.'
  # Email is optional (ADR 0020): its other settings mean nothing without the host.
  [[ -n $smtp_host || (-z $smtp_port && -z $smtp_from && $user_given == 0) ]] || fail 'Give --smtp-host with the other SMTP options, or none of them.'

  # Everything up to the questions only reads: a refusal leaves the machine as it was.
  ((EUID == 0)) || fail 'Run with sudo.'
  [[ $(uname -s) == Linux ]] || fail 'A Linux machine is required.'
  case $(uname -m) in x86_64 | aarch64) ;; *) fail 'Unsupported architecture: the image is built for amd64 and arm64.' ;; esac
  here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  read_image "$here/image"
  for file in compose.yml Caddyfile; do
    [[ -f $here/$file && ! -L $here/$file ]] || fail "Run this installer from a release bundle: $file is missing."
  done
  assert_root_directory "$directory"
  assert_no_installation "$directory"
  if command -v docker >/dev/null; then
    docker info >/dev/null 2>&1 || fail 'Docker is installed, but its daemon does not answer.'
    docker compose version >/dev/null 2>&1 || fail 'The Docker Compose plugin is missing (https://docs.docker.com/compose/install/linux/).'
    assert_no_volumes
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
  # The first account is created here, on the server: no email is needed to start (ADR 0020).
  ask owner_email 'Email address of the first account (it is the sign-in name; nothing is sent to it)' valid_address 'An email address is required, for example you@example.com.'
  ask_owner_password
  # Email is only asked for when --smtp-host says the installation sends some.
  if [[ -n $smtp_host ]]; then
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
      read_hidden smtp_password || fail 'Invalid SMTP password: a single line of text is required.'
      printf '\n' >&2
      [[ -n $smtp_password ]] || fail 'An SMTP user needs a password.'
      valid_credential "$smtp_password" 4096 || fail 'Invalid SMTP password: a single line is required.'
    fi
  fi

  if ! command -v docker >/dev/null; then
    install_docker
    # Volumes outlive a removed Docker, and only show again now.
    assert_no_volumes
  fi
  admin_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  app_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  [[ $admin_password =~ ^[a-f0-9]{64}$ && $app_password =~ ^[a-f0-9]{64}$ ]] || fail 'Cannot generate the database passwords.'
  trap unfinished EXIT
  # Only .env is private. An existing directory keeps its mode.
  [[ -d $directory ]] || install -d -m 0755 "$directory"
  assert_root_directory "$directory"
  writing=1
  install -m 0644 "$here/compose.yml" "$here/Caddyfile" "$directory/"
  write_env "$directory/.env.new"
  mv -- "$directory/.env.new" "$directory/.env"
  unset smtp_password admin_password app_password
  cd -- "$directory"
  printf 'Downloading %s...\n' "${image%%@*}"
  compose pull
  printf 'Starting the control plane...\n'
  compose up -d
  writing=0

  printf 'Creating the account %s...\n' "$owner_email"
  if ! create_first_account; then
    unset owner_password
    printf 'shipkeep-install: the control plane is running, but the first account was not created. Create it with:\n' >&2
    printf '  cd %s && sudo docker compose -f compose.yml run --rm --no-deps control-plane node main.js account create --email %s\n' "$directory" "$owner_email" >&2
    exit 1
  fi
  unset owner_password

  printf 'Waiting for the HTTPS certificate of %s...\n' "$domain"
  until https_answers "$domain"; do
    attempt=$((attempt + 1))
    if ((attempt >= 24)); then
      printf 'The control plane is running, but https://%s does not answer with a valid certificate yet.\n' "$domain" >&2
      printf 'Check that %s points at this machine and that ports 80 and 443 are reachable from the internet.\n' "$domain" >&2
      printf 'Caddy keeps trying by itself: do not run this installer again. Its reasons are in: cd %s && sudo docker compose -f compose.yml logs caddy\n' "$directory" >&2
      exit 1
    fi
    sleep 5
  done
  printf '\nShipkeep is running at https://%s\n' "$domain"
  printf 'Sign in with %s and the password you chose.\n' "$owner_email"
  if [[ -n $smtp_host ]]; then
    printf 'Other people sign up by themselves: their confirmation code arrives by email.\n'
  else
    printf 'This installation sends no email: more accounts and lost passwords are handled on this server.\n'
    printf 'See https://github.com/shipkeepdev/shipkeep/blob/main/docs/INSTALL.md#accounts-without-email\n'
  fi
  printf 'The compose file and its settings are in %s. Keep .env private: it holds the database passwords.\n' "$directory"
  printf 'Back up the key-encryption key now: https://github.com/shipkeepdev/shipkeep/blob/main/docs/INSTALL.md#back-up-the-key-encryption-key\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
