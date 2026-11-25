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
# Well-formed UTF-8 (RFC 3629): no overlong form, no surrogate, nothing above U+10FFFF, no
# sequence cut short. This script runs in the C locale, where these brackets match bytes.
valid_utf8() {
  local tail=$'[\x80-\xbf]'
  local one=$'[\x01-\x7f]' two=$'[\xc2-\xdf]'"$tail"
  local three=$'(\xe0[\xa0-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]|\xed[\x80-\x9f])'"$tail"
  local four=$'(\xf0[\x90-\xbf]|[\xf1-\xf3][\x80-\xbf]|\xf4[\x80-\x8f])'"$tail$tail"
  [[ $1 =~ ^($one|$two|$three|$four)*$ ]]
}

# The password of the first account: one line of UTF-8 text, 15 to 128 characters counted as the
# control plane counts them (Unicode code points), so that it is not refused once the stack is
# started. In valid UTF-8 a code point is one byte that is not a continuation byte (10xxxxxx).
valid_owner_password() {
  [[ $1 != *[[:cntrl:]]* ]] || return 1
  valid_utf8 "$1" || return 1
  local leading=${1//[$'\x80'-$'\xbf']/}
  ((${#leading} >= 15 && ${#leading} <= 128))
}

# Starts from this script's own variables. A name inherited from the environment stays exported
# when it is assigned: every child, Docker included, would receive the passwords kept under these
# names. And Docker Compose prefers a variable of the environment to the settings file and to the
# bundled compose file, which alone must decide what the installation runs with.
own_variables() {
  unset -v owner_password smtp_password admin_password app_password
  unset -v SHIPKEEP_IMAGE SHIPKEEP_DOMAIN POSTGRES_ADMIN_PASSWORD POSTGRES_APP_PASSWORD
  unset -v SMTP_HOST SMTP_PORT SMTP_FROM SMTP_USER SMTP_PASSWORD
  # Every COMPOSE_* setting: COMPOSE_DISABLE_ENV_FILE alone would make Compose ignore .env.
  unset -v "${!COMPOSE_@}"
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

# The settings file is what makes an installation: the database is created with its passwords. A
# run stopped before writing it left only files that a new run replaces.
assert_no_installation() {
  [[ ! -e $1/.env && ! -L $1/.env ]] || fail "Existing installation in $1; refusing to overwrite it. To finish an interrupted one, run this installer with --dir $1 --resume yes."
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
  home=$(mktemp -d -- "${2%/*}/gnupg.XXXXXX") || return 1
  if gpg --homedir "$home" --batch --quiet --import "$1" 2>/dev/null; then
    listed=$(gpg --homedir "$home" --batch --quiet --with-colons --list-keys 2>/dev/null | awk -F: '$1=="pub" {keys++} $1=="fpr" && !first {first=$10} END {print keys ":" first}')
    if [[ $listed == "1:$3" ]] && gpg --homedir "$home" --batch --quiet --export "$3" >"$2" 2>/dev/null && [[ -s $2 ]]; then status=0; fi
  fi
  rm -rf -- "$home"
  return "$status"
}

# The bundled files only: Docker Compose would otherwise also load an override file found next to
# them. On a single machine (ADR 0021) the bundled override drops Caddy and keeps HTTP on loopback.
compose() {
  if ((single)); then
    docker compose --file compose.yml --file compose.single-machine.yml "$@"
  else
    docker compose --file compose.yml "$@"
  fi
}

# Single machine (ADR 0021): what the control plane keeps, and the smallest machine that leaves room
# for an application beside it. deploy/install.sh carries the same values and checks. Two machines
# until main says otherwise.
single=0 compose_files='-f compose.yml'
reserved_memory_bytes=1073741824
minimum_memory_bytes=3221225472
# True when the mounts file $1 has cgroup v2 on /sys/fs/cgroup with memory_recursiveprot.
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
valid_yes_no() {
  [[ $1 =~ ^(yes|no|y|n)$ ]]
}
# An organization name, as the control plane accepts it: 1 to 80 printable characters, no space at
# either end. Printable is ASCII here, stricter than the control plane, so no byte surprises it.
valid_organization() {
  [[ $1 =~ ^[[:print:]]{1,80}$ && $1 == "${1#[[:space:]]}" && $1 == "${1%[[:space:]]}" ]]
}
# The organization's slug, from its name: lowercase letters, digits and single hyphens, starting
# with a letter, at most 40 characters.
organization_slug() {
  local slug=${1,,}
  slug=${slug//[^a-z0-9]/-}
  while [[ $slug == *--* ]]; do slug=${slug//--/-}; done
  slug=${slug#-}
  [[ $slug =~ ^[a-z] ]] || slug=org-$slug
  slug=${slug:0:40}
  slug=${slug%-}
  printf '%s\n' "$slug"
}
# Reads the file $2 from the control plane image into $3, and checks it against the SHA-256 $1.
image_file() {
  [[ $1 =~ ^[a-f0-9]{64}$ ]] || return 1
  compose run --rm --no-deps -T --entrypoint cat control-plane "/app/web/browser/install/$2" >"$3" || return 1
  printf '%s  %s\n' "$1" "$3" | sha256sum --check --status
}

# Without a terminal, standard input holds the passwords only, one per line: any other answer must
# come as an option, or a password would be read as that answer, and could be printed back in an
# error about it.
on_terminal() {
  [[ -t 0 ]] || fail "Without a terminal, give $1: standard input holds the passwords only."
}

# Sets the variable named by $1 from the terminal, unless the option $5 already did. An invalid
# answer is asked again.
ask() {
  local name=$1 question=$2 check=$3 error=$4 option=$5 answer
  [[ -z ${!name} ]] || return 0
  on_terminal "$option"
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
    printf '%s\n' "$error" >&2
  done
}

# One line of a standard input that is not a terminal, into the variable named by $1, and not a
# byte more. It is read byte by byte because `read` drops a NUL byte without a word: the secret
# kept would then differ from the one given. A CR just before the line end belongs to that end
# (a file saved with CRLF), as the control plane reads it; a CR anywhere else stays, and is
# refused as a control character. Returns 2 for a NUL byte, 3 for a line too long.
read_piped_line() {
  local byte line=''
  while IFS= read -r -s -d '' -n 1 byte; do
    [[ -n $byte ]] || return 2
    [[ $byte != $'\n' ]] || break
    line+=$byte
    ((${#line} <= 4096)) || return 3
  done
  printf -v "$1" '%s' "${line%$'\r'}"
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
    if ((!status)) && [[ $owner_password != *[[:cntrl:]]* ]] && ! valid_utf8 "$owner_password"; then
      [[ -t 0 ]] || fail 'The password is not UTF-8 text: set the terminal or the file to UTF-8.'
      printf 'This is not UTF-8 text: set the terminal to UTF-8, then type the password again.\n' >&2
      continue
    fi
    if ((status)) || ! valid_owner_password "$owner_password"; then
      [[ -t 0 ]] || fail 'The first account needs a password of 15 to 128 characters, on one line, without tabs or other control characters.'
      printf 'Use between 15 and 128 characters, without tabs or other control characters.\n' >&2
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

# Ubuntu 24.04, the system the server installer supports, read from the os-release file $1.
ubuntu_noble() {
  local ID='' VERSION_ID=''
  [[ -f $1 ]] || return 1
  # shellcheck source=/dev/null
  . "$1"
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
}

# Whether the version $1, as Docker prints it (an optional v, then major.minor.patch and maybe a
# suffix), is at least $2.$3.$4.
version_at_least() {
  local major minor patch
  [[ ${1#v} =~ ^([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})([-+].*)?$ ]] || return 1
  major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
  ((major > $2 || (major == $2 && (minor > $3 || (minor == $3 && patch >= $4)))))
}
# Docker Compose 2.24.4 is the first to read `!override`, which compose.single-machine.yml uses to
# replace the published ports. $1 is what `docker compose version --short` says.
compose_reads_override() { version_at_least "$1" 2 24 4; }
# Before Docker Engine 28, hosts on the same network segment could reach a port published on
# 127.0.0.1, where the control plane's plain HTTP listens on one machine. $1 is the server version.
engine_keeps_loopback() { version_at_least "$1" 28 0 0; }

# The agent pins Docker API 1.47 (agent/internal/docker). $1 is the API version the daemon serves.
docker_api_for_agent() {
  [[ $1 =~ ^1\.([0-9]{1,3})$ ]] && ((10#${BASH_REMATCH[1]} >= 47))
}
# Whether this machine's Docker serves what the agent needs.
agent_docker() {
  docker_api_for_agent "$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null)"
}
# A separate machine installed without an agent of its own, for the reason $1: the control plane
# alone, upgraded by hand, as before ADR 0028. No organization is created, even with --organization.
without_agent() {
  agent=0 organization=''
  printf '%s: the control plane is installed without an agent of its own, and is upgraded by hand (docs/INSTALL.md).\n' "$1" >&2
}

# The checks of one machine that need Docker, before anything is written.
assert_single_machine_docker() {
  compose_reads_override "$(docker compose version --short 2>/dev/null)" || fail 'Applications on this machine need Docker Compose 2.24.4 or later. Upgrade the Compose plugin, then run this installer again: nothing was changed.'
  engine_keeps_loopback "$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || fail 'Applications on this machine need Docker Engine 28 or later: older engines let the local network reach ports published on 127.0.0.1. Upgrade Docker, then run this installer again: nothing was changed.'
}

# The steps done after the settings file, one per line in install-state, so that `--resume yes`
# runs only the ones left. It holds nothing secret: the settings of the run and the steps done.
record() {
  printf '%s\n' "$1" >>"$directory/install-state" || fail "Cannot write $directory/install-state."
}

# Reads install-state ($1), refusing anything the installer did not write.
read_state() {
  local line key value mode=''
  [[ -f $1 && ! -L $1 ]] || fail "No installation to resume in $directory."
  (($(wc -c <"$1") <= 4096)) || fail "$1 is not the installer's."
  while IFS= read -r line; do
    # The checks below run their own matches: the value is taken first.
    key=${line%%=*} value=${line#*=}
    [[ $line == *=* ]] || value=''
    case $key in
      mode) [[ -z $mode && $value =~ ^(single|separate)$ ]] || fail "$1 is not the installer's."
        mode=$value
        [[ $mode == separate ]] || single=1 compose_files='-f compose.yml -f compose.single-machine.yml' ;;
      domain) valid_domain "$value" || fail "$1 is not the installer's."
        domain=$value ;;
      email) valid_address "$value" || fail "$1 is not the installer's."
        owner_email=$value ;;
      organization) valid_organization "$value" || fail "$1 is not the installer's."
        organization=$value ;;
      organization_id) [[ $value =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "$1 is not the installer's."
        organization_id=$value ;;
      email_mode) [[ $value =~ ^(smtp|none)$ ]] || fail "$1 is not the installer's."
        [[ $value == none ]] || sends_email=1 ;;
      organization_created) [[ $line == organization_created ]] || fail "$1 is not the installer's."
        organization_done=1 ;;
      started) [[ $line == started ]] || fail "$1 is not the installer's."
        started=1 ;;
      account) [[ $line == account ]] || fail "$1 is not the installer's."
        account_done=1 ;;
      server) [[ $line == server ]] || fail "$1 is not the installer's."
        server_done=1 ;;
      *) fail "$1 is not the installer's." ;;
    esac
  done <"$1"
  [[ -n $mode && -n $domain && -n $owner_email ]] || fail "$1 is not the installer's."
  ((!single)) || [[ -n $organization ]] || fail "$1 is not the installer's."
}

# Creates the first account with the command line of the control plane (ADR 0020). The password
# goes on standard input: an argument or a variable could be read by other processes.
create_first_account() {
  printf '%s\n' "$owner_password" | compose run --rm --no-deps -T control-plane node main.js account create --email "$owner_email"
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
  apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg </dev/null >/dev/null
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
  apt-get install -y -qq --download-only --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin </dev/null >/dev/null
  # Keep the update source once package application can leave Docker installed.
  # shellcheck disable=SC2034
  keep_repository=1
  apt-get install -y -qq --no-download --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin </dev/null >/dev/null
)

# Ubuntu 24.04 only, from Docker's own repository, with its signing key pinned (as the server
# installer does). Elsewhere the operator installs Docker.
install_docker() {
  local package
  ubuntu_noble /etc/os-release && [[ -d /run/systemd/system ]] || fail 'Docker is not installed. Install Docker Engine and its Compose plugin (https://docs.docker.com/engine/install/), then run this installer again.'
  for package in docker.io podman-docker containerd runc; do
    ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || fail 'Conflicting Docker packages; reconcile them manually.'
  done
  printf 'Installing Docker from its signed repository...\n'
  export DEBIAN_FRONTEND=noninteractive
  install_docker_packages /etc/apt
  systemctl enable --quiet --now docker
}

# Asks the control plane, through Caddy, with certificate verification: it succeeds only once the
# certificate of the domain is issued. Over loopback, so that it does not depend on the route from
# this machine to its own public address.
https_answers() {
  # On a single machine the server's Caddy answers, on the host: the gateway of the control plane's
  # network reaches it.
  compose exec -T control-plane node -e '
    const name = process.argv[1];
    const host = process.argv[2];
    const request = require("node:https").get(
      { host, port: 443, servername: name, path: "/api/v1/health", headers: { host: name }, timeout: 8000 },
      (response) => process.exit(response.statusCode === 200 ? 0 : 1),
    );
    request.on("timeout", () => process.exit(1));
    request.on("error", () => process.exit(1));
  ' "$1" "$( ((single)) && printf 172.31.250.1 || printf 127.0.0.1)" >/dev/null 2>&1
}

# Printed when the run stops after the settings file is written and before the last step: its
# passwords must be kept, and the steps left are run by the same installer.
unfinished() {
  ((writing)) || return 0
  if [[ -e $directory/.env ]]; then
    printf 'shipkeep-install: the installation did not finish. Keep %s/.env: it holds the database passwords. Once the cause is fixed, finish with: sudo bash %q --dir %q --resume yes\n' "$directory" "$here/install.sh" "$directory" >&2
  else
    printf 'shipkeep-install: the installation stopped before its settings were written, and nothing was started. Run the installer again.\n' >&2
  fi
}

# ADR 0021: the first organization, owned by the first account, with the id organization_id the
# installer chose and recorded first: run again after an interruption, the command finds it.
create_organization() {
  local said
  said=$(compose run --rm --no-deps -T control-plane node main.js organization create --name "$organization" --slug "$(organization_slug "$organization")" --owner "$owner_email" --id "$organization_id") || {
    printf 'shipkeep-install: the control plane is running, but the organization %s was not created.\n' "$organization" >&2
    return 1
  }
  [[ $said == "Organization created: $organization_id" ]]
}

# A UUIDv7, the form of every tenant id: 48 bits of Unix time in milliseconds, the version, then
# random bits with the variant.
new_uuid7() {
  local ms random hex
  ms=$(date +%s%3N) || return 1
  [[ $ms =~ ^[0-9]{13}$ ]] || return 1
  random=$(od -An -N10 -tx1 /dev/urandom | tr -d ' \n') || return 1
  [[ $random =~ ^[0-9a-f]{20}$ ]] || return 1
  printf -v hex '%012x' "$ms"
  printf '%s-%s-7%s-%x%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${random:0:3}" $(((16#${random:3:1} & 3) | 8)) "${random:4:3}" "${random:7:12}"
}

# 0 when an earlier run installed this machine's agent for this control plane to the end (its
# services enabled, the installer's last step, and running), and the agent, once enrolled, belongs
# to organization_id; 1 when nothing is installed; 2 for an installation that is unfinished or not
# this one's, whose server part the operator removes. On a single machine it is a server, with its
# Caddy and egress proxy, that keeps the control plane's route; on a separate one, an agent only,
# with the control-plane-only role (ADR 0028).
# $1, empty on a server, roots the paths for the checks.
this_server_installed() {
  local root=${1:-} config credentials enrolled unit mark="    upstream: '127.0.0.1:3000'"
  local -a units=(shipkeep-agent shipkeep-caddy shipkeep-egress)
  ((single)) || units=(shipkeep-agent) mark='  role: control-plane-only'
  config=$root/etc/shipkeep/agent.yaml credentials=$root/var/lib/shipkeep/credentials.json
  [[ -e $config || -L $config || -e $root/etc/systemd/system/shipkeep-agent.service ]] || return 1
  [[ -f $config && ! -L $config ]] || return 2
  for unit in "${units[@]}"; do
    [[ -L $root/etc/systemd/system/multi-user.target.wants/$unit.service ]] || return 2
    [[ -n $root ]] || systemctl is-active --quiet "$unit" || return 2
  done
  grep -Fxq "  address: '$domain:7443'" "$config" && grep -Fxq "$mark" "$config" || return 2
  if [[ -f $credentials && ! -L $credentials ]]; then
    enrolled=$(grep -Eo '"organization_id": *"[0-9a-f-]{36}"' "$credentials" | grep -Eo '[0-9a-f-]{36}') || return 2
    [[ $enrolled == "$organization_id" ]] || return 2
  else
    # Not enrolled yet: the agent holds the token issued for this organization by that run.
    [[ ! -e $credentials && ! -L $credentials && -f $root/etc/shipkeep/join-token ]] || return 2
  fi
}

# ADR 0021, ADR 0028: this machine enrolled in organization_id, with the agent and the installer
# of the control plane's own image: as a server on a single machine, and as an agent alone, which
# runs no application, on a separate one. The join token goes from the control plane to the
# server installer through a pipe, never on a terminal or in a file of this script.
add_this_server() {
  local fingerprint manifest installer amd64 arm64 digest work status
  local -a role=(--local-control-plane 127.0.0.1:3000)
  ((single)) || role=(--control-plane-only yes)
  fingerprint=$(compose run --rm --no-deps -T control-plane node main.js server ca-fingerprint) || return 1
  [[ $fingerprint =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  manifest=$(compose run --rm --no-deps -T --entrypoint cat control-plane /app/web/browser/install/manifest.json) || return 1
  [[ $manifest =~ ^\{\"installer\":\"([a-f0-9]{64})\",\"amd64\":\"([a-f0-9]{64})\",\"arm64\":\"([a-f0-9]{64})\"\}$ ]] || {
    printf 'shipkeep-install: the control plane image holds no agent to install.\n' >&2
    return 1
  }
  installer=${BASH_REMATCH[1]} amd64=${BASH_REMATCH[2]} arm64=${BASH_REMATCH[3]}
  work=$(mktemp -d /var/lib/shipkeep-cp-install.XXXXXX) || return 1
  case $(uname -m) in x86_64) digest=$amd64 ;; *) digest=$arm64 ;; esac
  if ! image_file "$installer" "install-$installer.sh" "$work/install.sh" || ! image_file "$digest" "agent-$digest.bin" "$work/agent"; then
    rm -rf -- "$work"
    printf 'shipkeep-install: the agent of the control plane image does not match its checksum.\n' >&2
    return 1
  fi
  if ((single)); then
    printf 'Installing the agent and the edge proxy of this server...\n'
  else
    printf 'Installing the agent of this machine, which runs no application...\n'
  fi
  status=0
  compose run --rm --no-deps -T control-plane node main.js server join-token --organization "$organization_id" |
    bash "$work/install.sh" --control-plane "$domain:7443" --ca-fingerprint "$fingerprint" --origin "https://$domain" \
      --amd64-sha256 "$amd64" --arm64-sha256 "$arm64" "${role[@]}" --agent-file "$work/agent" || status=$?
  rm -rf -- "$work"
  ((status == 0)) || printf 'shipkeep-install: the control plane is running, but the agent of this machine was not installed.\n' >&2
  return "$status"
}

# PostgreSQL and the API run in this slice, protected up to the reservation (ADR 0021). Its parent,
# shipkeep.slice, gets the same protection from the server installer. Written once .env exists, so
# that a run stopped before leaves nothing a new run refuses, and again on resume.
controlplane_slice() {
  local unit=/etc/systemd/system/shipkeep-controlplane.slice
  printf '[Unit]\nDescription=Shipkeep: the control plane on the machine that also runs applications\nBefore=slices.target\n[Slice]\nMemoryLow=%d\n' "$reserved_memory_bytes" >"$unit.new"
  chmod 0644 "$unit.new"
  mv -- "$unit.new" "$unit"
  systemctl daemon-reload
  systemctl start shipkeep-controlplane.slice
}

# Everything after the settings file. Each step is recorded once done, so that `--resume yes`
# runs only those left; the wait for the certificate is not a step: Caddy keeps trying alone.
finish() {
  local attempt=0 status
  writing=1
  ((!single)) || controlplane_slice
  if ((!started)); then
    printf 'Downloading the images...\n'
    compose pull
  fi
  printf 'Starting the control plane...\n'
  compose up -d
  ((started)) || record started
  if ((!account_done)); then
    [[ -n $owner_password ]] || ask_owner_password
    printf 'Creating the account %s...\n' "$owner_email"
    status=0
    create_first_account || status=$?
    if ((status == 3)); then
      # A run stopped after the account was committed: it is kept as it is, password included.
      printf 'The account %s already exists: it is kept as it is.\n' "$owner_email"
    elif ((status != 0)); then
      unset owner_password
      printf 'shipkeep-install: the control plane is running, but the first account was not created.\n' >&2
      exit 1
    fi
    record account
  fi
  unset owner_password
  # The first organization and this machine's agent: on a single machine, and on a separate one
  # that can run the agent (ADR 0028), whose run recorded the organization's name.
  if ((single)) || [[ -n $organization ]]; then
    if ((!organization_done)); then
      if [[ -z $organization_id ]]; then
        organization_id=$(new_uuid7) || fail 'Cannot choose an organization id.'
        record "organization_id=$organization_id"
      fi
      create_organization || exit 1
      record organization_created
    fi
    if ((!server_done)); then
      status=0
      this_server_installed || status=$?
      if ((status == 2)); then
        if ((single)); then
          printf 'shipkeep-install: this machine has a Shipkeep server installation that is unfinished, or not the one of this control plane and organization. Remove its server part (see Starting over in docs/INSTALL.md), then resume.\n' >&2
        else
          printf 'shipkeep-install: this machine has a Shipkeep agent installation that is unfinished, or not the one of this control plane and organization. Remove its agent part (see Starting over in docs/INSTALL.md), then resume.\n' >&2
        fi
        exit 1
      elif ((status == 1)); then
        add_this_server || exit 1
      fi
      record server
    fi
  fi
  writing=0

  printf 'Waiting for the HTTPS certificate of %s...\n' "$domain"
  until https_answers "$domain"; do
    attempt=$((attempt + 1))
    if ((attempt >= 24)); then
      printf 'The control plane is running, but https://%s does not answer with a valid certificate yet.\n' "$domain" >&2
      printf 'Check that %s points at this machine and that ports 80 and 443 are reachable from the internet.\n' "$domain" >&2
      if ((single)); then
        printf 'Caddy keeps trying by itself: do not run this installer again. Its reasons are in: sudo journalctl -u shipkeep-caddy\n' >&2
      else
        printf 'Caddy keeps trying by itself: do not run this installer again. Its reasons are in: cd %s && sudo docker compose -f compose.yml logs caddy\n' "$directory" >&2
      fi
      exit 1
    fi
    sleep 5
  done
  printf '\nShipkeep is running at https://%s\n' "$domain"
  printf 'Sign in with %s and the password you chose.\n' "$owner_email"
  if ((sends_email)); then
    printf 'Other people sign up by themselves: their confirmation code arrives by email.\n'
  else
    printf 'This installation sends no email: more accounts and lost passwords are handled on this server.\n'
    printf 'See https://github.com/shipkeepdev/shipkeep/blob/main/docs/INSTALL.md#accounts-without-email\n'
  fi
  if ((single)); then
    printf 'This machine is also a server of the organization %s: deploy applications to it from the Servers page.\n' "$organization"
    printf 'The compose files and their settings are in %s; give both files to Docker Compose: cd %s && sudo docker compose %s ...\n' "$directory" "$directory" "$compose_files"
    printf 'Keep .env private: it holds the database passwords.\n'
  else
    [[ -z $organization ]] || printf 'This machine runs an agent of the organization %s, which runs no application: add servers from the Servers page.\n' "$organization"
    printf 'The compose file and its settings are in %s. Keep .env private: it holds the database passwords.\n' "$directory"
  fi
  printf 'Back up the key-encryption key now: https://github.com/shipkeepdev/shipkeep/blob/main/docs/INSTALL.md#back-up-the-key-encryption-key\n'
}


main() {
  umask 077
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  local here file port listeners memory attempt=0 user_given=0
  own_variables
  directory=/opt/shipkeep writing=0
  domain='' owner_email='' owner_password=''
  smtp_host='' smtp_port='' smtp_from='' smtp_user='' smtp_password=''
  single_answer='' single=0 agent=0 organization='' compose_files='-f compose.yml'
  resume='' started=0 account_done=0 organization_done=0 server_done=0 organization_id='' sends_email=0
  while (($#)); do
    (($# >= 2)) || fail 'Missing option value.'
    case "$1" in
      --dir) directory=$2 ;;
      --domain) domain=$2 ;;
      --email) owner_email=$2 ;;
      --single-machine) single_answer=$2 ;;
      --organization) organization=$2 ;;
      --resume) resume=$2 ;;
      --smtp-host) smtp_host=$2 ;;
      --smtp-port) smtp_port=$2 ;;
      --smtp-from) smtp_from=$2 ;;
      --smtp-user) smtp_user=$2 user_given=1 ;;
      *) fail 'Unknown option. Options: --dir, --domain, --email, --single-machine yes|no, --organization, --resume yes, and for an installation that sends email --smtp-host, --smtp-port, --smtp-from, --smtp-user.' ;;
    esac
    shift 2
  done
  valid_directory "$directory" || fail 'Invalid directory: an absolute path is required.'
  [[ -z $domain ]] || valid_domain "$domain" || fail 'Invalid domain: a lowercase DNS name is required, for example shipkeep.example.com.'
  [[ -z $owner_email ]] || valid_address "$owner_email" || fail 'Invalid email address.'
  [[ -z $single_answer ]] || valid_yes_no "$single_answer" || fail 'Invalid --single-machine: yes or no.'
  [[ -z $resume || $resume == yes ]] || fail 'Invalid --resume: yes.'
  # The settings of an interrupted run come from its directory; options would contradict them.
  [[ -z $resume || (-z $domain$owner_email$single_answer$organization$smtp_host$smtp_port$smtp_from && $user_given == 0) ]] || fail 'Give --resume yes with --dir only: the other settings are those of the interrupted run.'
  [[ -z $organization ]] || valid_organization "$organization" || fail 'Invalid organization name: 1 to 80 printable characters.'
  [[ -z $smtp_host ]] || valid_smtp_host "$smtp_host" || fail 'Invalid SMTP host.'
  [[ -z $smtp_port ]] || valid_port "$smtp_port" || fail 'Invalid SMTP port.'
  [[ -z $smtp_from ]] || valid_address "$smtp_from" || fail 'Invalid sender address.'
  valid_credential "$smtp_user" 254 || fail 'Invalid SMTP user.'
  # Email is optional (ADR 0020): its other settings mean nothing without the host.
  [[ -n $smtp_host || (-z $smtp_port && -z $smtp_from && $user_given == 0) ]] || fail 'Give --smtp-host with the other SMTP options, or none of them.'
  # The answers every installation needs, refused before anything else when they cannot be asked.
  [[ -n $resume || (-n $single_answer && -n $domain && -n $owner_email) ]] || on_terminal '--single-machine yes or no, --domain and --email'

  # Everything up to the questions only reads: a refusal leaves the machine as it was.
  ((EUID == 0)) || fail 'Run with sudo.'
  [[ $(uname -s) == Linux ]] || fail 'A Linux machine is required.'
  case $(uname -m) in x86_64 | aarch64) ;; *) fail 'Unsupported architecture: the image is built for amd64 and arm64.' ;; esac
  here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  if [[ -n $resume ]]; then
    assert_root_directory "$directory"
    [[ -f $directory/.env && ! -L $directory/.env ]] || fail "No installation to resume in $directory: run the installer again without --resume."
    read_state "$directory/install-state"
    trap unfinished EXIT
    cd -- "$directory"
    finish
    return 0
  fi
  read_image "$here/image"
  for file in compose.yml compose.single-machine.yml Caddyfile backup.sh; do
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

  # ADR 0021: one machine runs the control plane and the applications, unless the person says no.
  if [[ -z $single_answer ]]; then
    printf 'Run applications on this machine too? A separate machine is safer for code you trust less than the control plane. [Y/n]: ' >&2
    IFS= read -r single_answer || single_answer=''
    [[ -n $single_answer ]] || single_answer=yes
    valid_yes_no "${single_answer,,}" || fail 'Answer yes or no.'
    single_answer=${single_answer,,}
  fi
  if [[ $single_answer == y* ]]; then
    single=1 compose_files='-f compose.yml -f compose.single-machine.yml'
    # The server installer runs at the end, once the account exists: its own refusals come first.
    ubuntu_noble /etc/os-release && [[ -d /run/systemd/system ]] || fail 'Applications on this machine need Ubuntu 24.04 with systemd, as every server does. Run with --single-machine no and add a separate server.'
    if command -v docker >/dev/null; then assert_single_machine_docker; fi
    (($(nproc) >= 2)) || fail 'Applications on this machine need at least 2 CPUs. Run with --single-machine no and add a separate server.'
    memory=$(memory_total_bytes /proc/meminfo) || fail 'Cannot read the memory of this machine.'
    ((memory >= minimum_memory_bytes)) || fail 'Applications on this machine need at least 3 GiB of memory. Run with --single-machine no and add a separate server.'
    cgroup2_recursiveprot /proc/self/mounts || fail 'Applications on this machine need cgroup v2 mounted with memory_recursiveprot (systemd 247 or later).'
    listeners=$(ss -H -ltn 'sport = :3000') || fail 'Cannot inspect TCP ports.'
    [[ -z $listeners ]] || fail 'Port 3000 is already in use on this machine; the control plane listens there on loopback.'
    listeners=$(ss -H -ltn 'sport = :7480') || fail 'Cannot inspect TCP ports.'
    [[ -z $listeners ]] || fail 'Port 7480 is already in use on this machine; the egress proxy of the server listens there.'
    for file in /etc/systemd/system/shipkeep-controlplane.slice /etc/shipkeep; do
      [[ ! -e $file && ! -L $file ]] || fail "$file already exists: this machine already runs Shipkeep."
    done
    agent=1
  elif ubuntu_noble /etc/os-release && [[ -d /run/systemd/system ]]; then
    # ADR 0028: on the system every server runs, the control plane's own machine gets an agent
    # too, which runs no application. Elsewhere the control plane is upgraded by hand.
    [[ ! -e /etc/shipkeep && ! -L /etc/shipkeep ]] || fail '/etc/shipkeep already exists: this machine already runs Shipkeep.'
    agent=1
    if command -v docker >/dev/null && ! agent_docker; then without_agent 'Docker on this machine serves an API older than 1.47, which the agent needs'; fi
  else
    without_agent 'This system is not Ubuntu 24.04 with systemd'
  fi

  ask domain 'DNS name of the control plane, for example shipkeep.example.com' valid_domain 'A lowercase DNS name is required, for example shipkeep.example.com.' --domain
  # Without its DNS record Caddy cannot obtain the certificate, and failed attempts are rate limited.
  if command -v getent >/dev/null; then
    getent ahosts "$domain" >/dev/null || fail "$domain does not resolve. Create its DNS record pointing at this machine, then run this installer again: nothing was changed."
  fi
  # The first account is created here, on the server: no email is needed to start (ADR 0020).
  ask owner_email 'Email address of the first account (it is the sign-in name; nothing is sent to it)' valid_address 'An email address is required, for example you@example.com.' --email
  ask_owner_password
  if ((agent)); then
    ask organization 'Name of the first organization, for example your company or team' valid_organization 'An organization name of 1 to 80 printable characters is required.' --organization
  fi
  # Email is only asked for when --smtp-host says the installation sends some.
  if [[ -n $smtp_host ]]; then
    [[ -n $smtp_port ]] || smtp_port=465
    ask smtp_from 'Sender address, for example shipkeep@example.com' valid_address 'A sender address is required.' --smtp-from
    if ((!user_given)); then
      on_terminal '--smtp-user (empty when the server asks for no login)'
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
  if ((single)); then
    # With the cgroupfs driver, cgroup_parent is a plain path and no slice would hold the containers.
    [[ $(docker info --format '{{.CgroupDriver}}') == systemd ]] || fail "Applications on this machine need Docker's systemd cgroup driver."
    assert_single_machine_docker
  elif ((agent)) && ! agent_docker; then
    without_agent 'Docker on this machine serves an API older than 1.47, which the agent needs'
  fi
  admin_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  app_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  [[ $admin_password =~ ^[a-f0-9]{64}$ && $app_password =~ ^[a-f0-9]{64}$ ]] || fail 'Cannot generate the database passwords.'
  trap unfinished EXIT
  # Only .env is private. An existing directory keeps its mode.
  [[ -d $directory ]] || install -d -m 0755 "$directory"
  assert_root_directory "$directory"
  writing=1
  install -m 0644 "$here/compose.yml" "$here/compose.single-machine.yml" "$here/Caddyfile" "$directory/"
  # Instance backup and restore (ADR 0026).
  install -m 0755 "$here/backup.sh" "$directory/"
  # What a run stopped before .env left behind: never used, since nothing started without .env.
  rm -f -- "$directory/.env.new" "$directory/install-state.new"
  # What --resume yes needs to finish, nothing secret, in place before .env: whoever finds .env
  # finds it too.
  [[ -z $smtp_host ]] || sends_email=1
  set -o noclobber
  {
    printf 'mode=%s\n' "$( ((single)) && printf single || printf separate)"
    printf 'domain=%s\nemail=%s\nemail_mode=%s\n' "$domain" "$owner_email" "$( ((sends_email)) && printf smtp || printf none)"
    ((!agent)) || printf 'organization=%s\n' "$organization"
  } >"$directory/install-state.new" || fail "Cannot create $directory/install-state.new."
  set +o noclobber
  mv -- "$directory/install-state.new" "$directory/install-state"
  write_env "$directory/.env.new"
  mv -- "$directory/.env.new" "$directory/.env"
  unset smtp_password admin_password app_password
  cd -- "$directory"
  finish
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
