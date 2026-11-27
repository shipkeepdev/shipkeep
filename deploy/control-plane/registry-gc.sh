#!/usr/bin/env bash
# Frees the layers of the images the control plane's retention removed from the installation's
# registry (ADR 0030): Distribution's garbage collection, run while the registry is read-only, so
# that no push lands while it decides what is unused. Pulls go on meanwhile; a push fails, as the
# build that makes it does. Run as root, from the directory of compose.yml (/opt/shipkeep): the
# shipkeep-registry-gc timer runs it every day at 03:30 UTC, an hour after retention.
set -Eeuo pipefail
umask 077

fail() {
  printf 'shipkeep-registry-gc: %s\n' "$*" >&2
  exit 1
}

directory=$(pwd -P)
[[ -f $directory/compose.yml && ! -L $directory/compose.yml ]] || fail 'Run this from the directory of compose.yml.'

# The compose files the installation was started with, as Docker Compose recorded them on the
# registry's container: on a single machine (ADR 0021) the override is one of them.
files=()
container=$(docker compose --file compose.yml ps --quiet registry) || fail 'Docker Compose does not answer.'
[[ -n $container ]] || fail 'The registry is not running: start the control plane with docker compose up -d first.'
labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
IFS=, read -r -a paths <<<"$labels"
for path in "${paths[@]}"; do
  [[ $path == "$directory"/* && -f $path && ! -L $path ]] || fail "Unexpected compose file: $path"
  files+=(--file "$path")
done
((${#files[@]})) || fail 'Cannot tell which compose files started this installation.'
compose() {
  docker compose "${files[@]}" "$@"
}

# Whatever happens, the registry takes pushes again.
restore() {
  SHIPKEEP_REGISTRY_READ_ONLY=false compose up -d --no-deps registry >/dev/null 2>&1 ||
    printf 'shipkeep-registry-gc: the registry could not be made writable again: run docker compose up -d registry.\n' >&2
}
trap restore EXIT
SHIPKEEP_REGISTRY_READ_ONLY=true compose up -d --no-deps registry >/dev/null
compose run --rm --no-deps -T --entrypoint registry registry \
  garbage-collect --delete-untagged /etc/distribution/config.yml
