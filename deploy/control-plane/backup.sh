#!/usr/bin/env bash
# Instance backup of the Shipkeep control plane (ADR 0026, docs/INSTALL.md, "Back up and restore").
# Run it as root, from the directory of compose.yml (/opt/shipkeep):
#
#   ./backup.sh keygen IDENTITY_FILE            once: a key pair; keep IDENTITY_FILE off this server
#   ./backup.sh create ARCHIVE                  the database and the key-encryption key, encrypted
#   ./backup.sh restore ARCHIVE IDENTITY_FILE   into a fresh installation, same version or later
#
# The database never touches the disk in clear: pg_dump and pg_restore run in the postgres
# container, and their output goes through the control plane image's `backup` commands in a pipe.
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# The file being written, removed on any exit until it is renamed into place: an interrupted
# keygen must not leave the identity on this server. A signal becomes an exit, which runs the trap.
partial=''
trap '[[ -z $partial ]] || rm -f -- "$partial"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  fail 'Usage: ./backup.sh keygen IDENTITY_FILE | create ARCHIVE | restore ARCHIVE IDENTITY_FILE [--replace-this-installation]'
}

directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$directory"
[[ -f compose.yml ]] || fail "Run this script from the directory of compose.yml: $directory has none."
command -v docker >/dev/null || fail 'Docker is not installed here.'

# The compose files the installation was started with, as Docker Compose recorded them on its
# containers: on a single machine (ADR 0021) the override is one of them, and `up` must keep it.
files=()
read_compose_files() {
  local container labels path
  container=$(docker compose --file compose.yml ps --quiet postgres) || fail 'Docker Compose does not answer.'
  [[ -n $container ]] || fail 'PostgreSQL is not running: start the control plane with docker compose up -d first.'
  labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
  IFS=, read -r -a paths <<<"$labels"
  for path in "${paths[@]}"; do
    [[ $path == "$directory"/* && -f $path && ! -L $path ]] || fail "Unexpected compose file: $path"
    files+=(--file "$path")
  done
  ((${#files[@]})) || fail 'Cannot tell which compose files started this installation.'
}

compose() {
  docker compose "${files[@]}" "$@"
}

# Writes to a new file next to the target, then renames it: never a part of one under the name.
fresh() {
  [[ -n $1 ]] || usage
  [[ ! -e $1 && ! -L $1 ]] || fail "$1 exists: choose another name."
  [[ ! -e $1.partial && ! -L $1.partial ]] || fail "$1.partial exists: an earlier run was stopped. Delete it first."
  partial=$1.partial
}

case ${1:-} in
  keygen)
    (($# == 2)) || usage
    fresh "$2"
    read_compose_files
    compose run --rm -T backup keygen >"$partial" || fail 'The key pair was not created.'
    mv -- "$partial" "$2"
    partial=''
    printf 'Identity written to %s. Copy it off this server, then delete it here: restoring needs it.\n' "$2" >&2
    ;;
  create)
    (($# == 2)) || usage
    fresh "$2"
    read_compose_files
    if ! compose exec -T postgres pg_dump --username=shipkeep_admin --dbname=shipkeep --format=custom |
      compose run --rm -T backup create >"$partial"; then
      fail 'The backup was not created; nothing was written.'
    fi
    mv -- "$partial" "$2"
    partial=''
    printf 'Backup written to %s. Copy it off this server.\n' "$2" >&2
    ;;
  restore)
    (($# == 3 || $# == 4)) || usage
    archive=$2 identity=$3
    [[ -f $archive && -r $archive ]] || fail "Cannot read the archive $archive."
    [[ -f $identity && -r $identity ]] || fail "Cannot read the identity file $identity."
    if [[ ${4:-} != --replace-this-installation ]]; then
      [[ -z ${4:-} ]] || usage
      printf 'This replaces the database and the key-encryption key of this installation with the backup. Type replace to continue: ' >&2
      IFS= read -r answer || answer=''
      [[ $answer == replace ]] || fail 'Nothing was changed.'
    fi
    read_compose_files
    # psql DATABASE ARGUMENTS...
    psql() {
      local database=$1
      shift
      compose exec -T postgres psql --username=shipkeep_admin --dbname="$database" --no-psqlrc \
        --set=ON_ERROR_STOP=1 --quiet "$@"
    }
    # Nothing may use the database while it is replaced.
    compose stop control-plane
    # The database first, into a new one: the current database is untouched until it is complete.
    # (pg_restore --clean cannot drop what the job queue's partitioned tables inherit.)
    psql postgres --command='DROP DATABASE IF EXISTS shipkeep_restore' --command='CREATE DATABASE shipkeep_restore OWNER shipkeep_admin' ||
      fail 'Cannot prepare the database to restore into. The control plane is stopped: start it with docker compose up -d.'
    if ! cat -- "$identity" "$archive" | compose run --rm -T backup restore-database |
      compose exec -T postgres pg_restore --username=shipkeep_admin --dbname=shipkeep_restore \
        --single-transaction --exit-on-error; then
      # What was restored, if anything, goes: nothing of a refused archive is kept.
      psql postgres --command='DROP DATABASE IF EXISTS shipkeep_restore' >/dev/null 2>&1 || true
      fail 'The database was not restored, and was left as it was. The control plane is stopped: run this again, or start it with docker compose up -d.'
    fi
    # The restored database is as it was at the backup's time, so a session revoked since then would
    # be live again. Every session ends, and so does every unused email link: people sign in again.
    if ! psql shipkeep_restore --single-transaction \
      --command='UPDATE user_sessions SET revoked_at = now() WHERE revoked_at IS NULL' \
      --command='UPDATE identity_tokens SET used_at = now() WHERE used_at IS NULL' >/dev/null; then
      psql postgres --command='DROP DATABASE IF EXISTS shipkeep_restore' >/dev/null 2>&1 || true
      fail 'The sessions of the restored database could not be ended, so it was not used: the current database was left as it was. The control plane is stopped: run this again, or start it with docker compose up -d.'
    fi
    # Then it takes the place of the current one, which is kept under another name. Both renames
    # are one transaction: if either fails, shipkeep is still the current database. The control
    # plane is stopped, so a session still open on the database is one it left behind: a
    # connection whose end never reached PostgreSQL, as when `up -d` recreates the namespace the
    # control plane shares. Those are ended first, or the rename would be refused.
    previous=shipkeep_before_restore_$(date -u +%Y%m%d%H%M%S)
    psql postgres --single-transaction \
      --command="SELECT count(pg_terminate_backend(pid, 10000)) FROM pg_stat_activity WHERE datname = 'shipkeep' AND pid <> pg_backend_pid()" \
      --command="ALTER DATABASE shipkeep RENAME TO $previous" --command='ALTER DATABASE shipkeep_restore RENAME TO shipkeep' >/dev/null ||
      fail 'The restored database could not take the place of the current one, which was left as it was. The control plane is stopped: run this again, or start it with docker compose up -d.'
    # Then the key, which the restored secrets are encrypted with. The one it replaces is kept.
    if ! cat -- "$identity" "$archive" | compose run --rm -T backup restore-key --replace-this-installation; then
      fail "The database is restored, but the key-encryption key may not be: the key file holds this installation's key or the restored one. The control plane is stopped: run this again before starting it. The previous database is kept as $previous."
    fi
    # Migrations bring an older backup to this version; the database login gets its grants again.
    compose up -d
    printf 'Restored. Servers reconnect on their own once the domain of this installation points to this machine. Every session was ended: everyone signs in again.\n' >&2
    printf 'The previous database is kept as %s; drop it once you are satisfied:\n  docker compose exec postgres dropdb --username=shipkeep_admin %s\n' "$previous" "$previous" >&2
    ;;
  *)
    usage
    ;;
esac
