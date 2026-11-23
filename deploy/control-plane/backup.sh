#!/usr/bin/env bash
# Instance backup of the Shipkeep control plane (ADR 0026, docs/INSTALL.md, "Back up and restore").
# Run it as root, from the directory of compose.yml (/opt/shipkeep):
#
#   ./backup.sh keygen IDENTITY_FILE            once: a key pair; keep IDENTITY_FILE off this server
#   ./backup.sh create ARCHIVE                  the database and the key-encryption key, encrypted
#   ./backup.sh create --s3                     the same, straight to the S3 destination of .env
#   ./backup.sh list | check                    the archives in that destination | test its settings
#   ./backup.sh restore ARCHIVE IDENTITY_FILE   into a fresh installation, same version or later;
#                                               ARCHIVE is a file, or s3:NAME from the destination
#
# The database never touches the disk in clear: pg_dump and pg_restore run in the postgres
# container, and their output goes through the control plane image's `backup` commands in a pipe.
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  fail 'Usage: ./backup.sh keygen IDENTITY_FILE | create ARCHIVE | create --s3 | list | check | restore ARCHIVE|s3:NAME IDENTITY_FILE [--replace-this-installation]'
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
}

case ${1:-} in
  keygen)
    (($# == 2)) || usage
    fresh "$2"
    read_compose_files
    compose run --rm -T backup keygen >"$2.partial" || {
      rm -f -- "$2.partial"
      fail 'The key pair was not created.'
    }
    mv -- "$2.partial" "$2"
    printf 'Identity written to %s. Copy it off this server, then delete it here.\n' "$2" >&2
    ;;
  create)
    (($# == 2)) || usage
    read_compose_files
    dump() {
      compose exec -T postgres pg_dump --username=shipkeep_admin --dbname=shipkeep --format=custom
    }
    if [[ $2 == --s3 ]]; then
      # Straight to the storage: the archive is never a file on this server.
      name=shipkeep-$(date -u +%Y%m%d-%H%M%S).age
      if ! dump | compose run --rm -T backup create | compose run --rm -T backup-transfer upload "$name"; then
        # The upload may have taken all it was given of a dump that failed: never keep that.
        compose run --rm -T backup-transfer discard "$name" >/dev/null 2>&1 ||
          printf 'Delete %s from the storage: it is incomplete.\n' "$name" >&2
        fail 'The backup was not stored.'
      fi
      printf 'Backup stored as %s.\n' "$name" >&2
    else
      fresh "$2"
      if ! dump | compose run --rm -T backup create >"$2.partial"; then
        rm -f -- "$2.partial"
        fail 'The backup was not created; nothing was written.'
      fi
      mv -- "$2.partial" "$2"
      printf 'Backup written to %s. Copy it off this server.\n' "$2" >&2
    fi
    ;;
  list | check)
    (($# == 1)) || usage
    read_compose_files
    compose run --rm -T backup-transfer "$1"
    ;;
  restore)
    (($# == 3 || $# == 4)) || usage
    archive=$2 identity=$3
    [[ -f $identity && -r $identity ]] || fail "Cannot read the identity file $identity."
    read_compose_files
    if [[ $archive == s3:* ]]; then
      # Fetched into a private directory: it is encrypted, and removed when this ends.
      work=$(mktemp -d)
      trap 'rm -rf -- "$work"' EXIT
      compose run --rm -T backup-transfer download "${archive#s3:}" >"$work/archive.age" ||
        fail "Cannot fetch ${archive#s3:} from the S3 destination; nothing was changed."
      archive=$work/archive.age
    fi
    [[ -f $archive && -r $archive ]] || fail "Cannot read the archive $archive."
    if [[ ${4:-} != --replace-this-installation ]]; then
      [[ -z ${4:-} ]] || usage
      printf 'This replaces the database and the key-encryption key of this installation with the backup. Type replace to continue: ' >&2
      IFS= read -r answer || answer=''
      [[ $answer == replace ]] || fail 'Nothing was changed.'
    fi
    psql() {
      compose exec -T postgres psql --username=shipkeep_admin --dbname=postgres --no-psqlrc \
        --set=ON_ERROR_STOP=1 --quiet "$@"
    }
    # Nothing may use the database while it is replaced.
    compose stop control-plane
    # The database first, into a new one: the current database is untouched until it is complete.
    # (pg_restore --clean cannot drop what the job queue's partitioned tables inherit.)
    psql --command='DROP DATABASE IF EXISTS shipkeep_restore' --command='CREATE DATABASE shipkeep_restore OWNER shipkeep_admin' ||
      fail 'Cannot prepare the database to restore into. The control plane is stopped: start it with docker compose up -d.'
    if ! cat -- "$identity" "$archive" | compose run --rm -T backup restore-database |
      compose exec -T postgres pg_restore --username=shipkeep_admin --dbname=shipkeep_restore \
        --single-transaction --exit-on-error; then
      fail 'The database was not restored, and was left as it was. The control plane is stopped: run this again, or start it with docker compose up -d.'
    fi
    # Then it takes the place of the current one, which is kept under another name.
    previous=shipkeep_before_restore_$(date -u +%Y%m%d%H%M%S)
    psql --command="ALTER DATABASE shipkeep RENAME TO $previous" --command='ALTER DATABASE shipkeep_restore RENAME TO shipkeep' ||
      fail 'The restored database could not take the place of the current one. The control plane is stopped: run this again.'
    # Then the key, which the restored secrets are encrypted with. The one it replaces is kept.
    if ! cat -- "$identity" "$archive" | compose run --rm -T backup restore-key --replace-this-installation; then
      fail "The database is restored but its key is not: run this again before starting the control plane. The previous database is $previous."
    fi
    # Migrations bring an older backup to this version; the database login gets its grants again.
    compose up -d
    printf 'Restored. Servers reconnect on their own once the domain of this installation points to this machine.\n' >&2
    printf 'The previous database is kept as %s; drop it once you are satisfied:\n  docker compose exec postgres dropdb --username=shipkeep_admin %s\n' "$previous" "$previous" >&2
    ;;
  *)
    usage
    ;;
esac
