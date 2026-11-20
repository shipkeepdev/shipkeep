#!/usr/bin/env bash
# Assembles the control plane bundle of a release: the installer, the files it installs,
# .env.example for a manual installation, and the image reference by tag and digest.
#   build-bundle.sh <version> <image-reference> <output-directory>
# Prints the path of the archive. The same inputs give the same bytes.
set -euo pipefail
fail() {
  printf 'build-bundle: %s\n' "$1" >&2
  exit 1
}
(($# == 3)) || fail 'usage: build-bundle.sh <version> <image-reference> <output-directory>'
version=$1 reference=$2 output=$3
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail 'Invalid version.'
[[ $reference =~ ^[a-z0-9]([a-z0-9._/-]{0,198}[a-z0-9])?:[A-Za-z0-9._-]{1,128}@sha256:[a-f0-9]{64}$ ]] || fail 'The image reference must carry a tag and a digest.'
tagged=${reference%%@*}
[[ ${tagged##*:} == "$version" ]] || fail 'The image tag is not the version.'
source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(cd -- "$source/../.." && pwd -P)
mkdir -p -- "$output"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
root=$work/shipkeep-control-plane
install -d -m 0755 "$root"
install -m 0755 "$source/install.sh" "$root/install.sh"
install -m 0644 "$source/compose.yml" "$source/compose.single-machine.yml" "$source/Caddyfile" "$source/.env.example" "$repository/LICENSE" "$repository/NOTICE" "$root/"
printf '%s\n' "$reference" >"$root/image"
chmod 0644 "$root/image"
archive=$output/shipkeep-control-plane_$version.tar.gz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH:-0}" -C "$work" -cf - shipkeep-control-plane | gzip -n >"$archive"
printf '%s\n' "$archive"
