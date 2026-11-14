#!/usr/bin/env bash
# Checks of the control plane installer that need no root: input boundaries, refusals, the
# settings file read back by Docker Compose from a real container, and the release bundle.
set -euo pipefail
cd "$(dirname "$0")/../.."
((EUID != 0)) || { printf 'Run these checks as a regular user: they rely on the sudo refusal.\n' >&2; exit 1; }
installer=deploy/control-plane/install.sh
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
secret='S3cret-never-printed'
long=$(printf 'a%.0s' {1..300})
die() {
  printf 'FAILED: %s\n' "$1" >&2
  exit 1
}

# Invalid options stop before the sudo check and before any question, also under bash -x.
refuse() {
  local expected=$1
  shift
  if printf '%s\n' "$secret" | bash -x "$installer" "$@" >"$work/output" 2>&1; then die "accepted: $*"; fi
  grep -q -- "$expected" "$work/output" || die "no '$expected' for: $*"
  ! grep -q -- "$secret" "$work/output" || die "the password was printed for: $*"
  # Only the line that turns tracing off may be traced.
  (($(grep -c '^+' "$work/output") <= 1)) || die "the run was traced for: $*"
}
# shellcheck disable=SC2016
for directory in relative/path /opt/../etc /opt/./shipkeep / /opt/shipkeep/ /opt//shipkeep '/opt/ship keep' '/opt/$(id)' "/opt/shipkeep'" $'/opt/shipkeep\nx' "/opt/$long"; do
  refuse 'Invalid directory' --dir "$directory"
done
# shellcheck disable=SC2016
for domain in shipkeep 1.2.3.4 Shipkeep.Example.com a..example.com -a.example.com a-.example.com '$(id).example.com' "example.com'" $'example.com\nx' 'a b.example.com' ../example.com 'example.com;id' "${long:0:64}.example.com" "${long:0:63}.${long:0:63}.${long:0:63}.${long:0:60}.com"; do
  refuse 'Invalid domain' --domain "$domain"
done
# shellcheck disable=SC2016
for host in 'smtp host' '$(id)' "smtp.example.com'" -smtp.example.com 'smtp.example.com;id' $'smtp.example.com\nx' "$long"; do
  refuse 'Invalid SMTP host' --smtp-host "$host"
done
for port in 0 65536 465x -1 999999 '4 65'; do
  refuse 'Invalid SMTP port' --smtp-port "$port"
done
for address in shipkeep 'a@b c' "a@example.com'" 'a b@example.com' $'a@example.com\nBcc: b@example.com' "$long@example.com" 'a@example.com>'; do
  refuse 'Invalid sender address' --smtp-from "$address"
done
refuse 'Invalid SMTP user' --smtp-user $'user\nname'
refuse 'Invalid SMTP user' --smtp-user "$long"
refuse 'Unknown option' --image example.com/other:1
refuse 'Missing option value' --domain
# Valid options go as far as the sudo check, and no further without root.
refuse 'Run with sudo' --dir /opt/shipkeep --domain shipkeep.example.com --smtp-host smtp.example.com --smtp-port 465 --smtp-from shipkeep@example.com --smtp-user user@example.com

# The remaining checks call the installer's own functions.
# shellcheck source=/dev/null
. "$installer"
refused() { ! ("$@") 2>"$work/output"; }

mkdir "$work/fresh" "$work/installed" "$work/linked"
assert_no_installation "$work/fresh"
: >"$work/installed/.env"
ln -s /nonexistent "$work/linked/compose.yml"
refused assert_no_installation "$work/installed" || die 'an existing settings file was accepted'
grep -q 'Existing installation' "$work/output" || die 'an existing settings file was refused without saying why'
refused assert_no_installation "$work/linked" || die 'a dangling link was accepted'

digest=$(printf 'a%.0s' {1..64})
reference=ghcr.io/shipkeepdev/shipkeep:1.2.3@sha256:$digest
printf '%s\n' "$reference" >"$work/image"
read_image "$work/image"
[[ $image == "$reference" ]] || die 'the image reference was not read'
ln -s "$work/image" "$work/image-link"
printf '%s\n' "ghcr.io/shipkeepdev/shipkeep:1.2.3" >"$work/image-tag-only"
printf '%s\n' "ghcr.io/shipkeepdev/shipkeep:1.2.3@sha256:$(printf '0%.0s' {1..64})" >"$work/image-dry-run"
printf '%s\nmore\n' "$reference" >"$work/image-two-lines"
# shellcheck disable=SC2016
printf '%s\n' 'ghcr.io/$(id)/shipkeep:1.2.3@sha256:'"$digest" >"$work/image-injection"
for file in missing image-link image-tag-only image-dry-run image-two-lines image-injection; do
  refused read_image "$work/$file" || die "accepted the image file $file"
done

# Every value must reach a container exactly as it was typed, whatever characters it holds.
# shellcheck disable=SC2016,SC1003
values=(plain 'pa$$word$HOME${X}' 'pa ss #word' "it's" 'say "hi"' 'back\slash' 'trail\' "a\\'b" 'a\nb' ' lead trail ' '`id`!&|<>*?~()[]{}' 'pässwörd€' '${POSTGRES_ADMIN_PASSWORD}' '\' '\"' '\$HOME' '$' '"' '' "'" '#start' 'k=v:@%+/,;')
probe=$(sed -n 's/^    image: \(caddy:.*\)$/\1/p' deploy/control-plane/compose.yml)
[[ -n $probe ]] || die 'no image to run the probe with'
mkdir "$work/values"
{
  printf 'services:\n  probe:\n    image: %s\n    network_mode: none\n    environment:\n' "$probe"
  # shellcheck disable=SC2016
  for index in "${!values[@]}"; do printf '      V%s: ${V%s:-}\n' "$index" "$index"; done
} >"$work/values/compose.yml"
{
  printf 'POSTGRES_ADMIN_PASSWORD="must-not-be-substituted"\n'
  for index in "${!values[@]}"; do env_line "V$index" "${values[index]}"; done
} >"$work/values/.env"
docker compose --project-directory "$work/values" run --rm --no-deps -T probe env >"$work/values/seen"
for index in "${!values[@]}"; do
  grep -Fxq -- "V$index=${values[index]}" "$work/values/seen" || die "the value number $index did not reach the container unchanged"
done

# The settings file holds everything the compose file requires.
mkdir "$work/settings"
# The installer's write_env reads these.
# shellcheck disable=SC2034
image=$reference domain=shipkeep.example.com admin_password=$digest app_password=$digest
# shellcheck disable=SC2034
smtp_host=smtp.example.com smtp_port=465 smtp_from=shipkeep@example.com smtp_user=user@example.com smtp_password=$secret
write_env "$work/settings/.env"
cp deploy/control-plane/compose.yml deploy/control-plane/Caddyfile "$work/settings/"
docker compose --project-directory "$work/settings" config --quiet
[[ $(grep -c '' "$work/settings/.env") == 10 ]] || die 'unexpected settings file'

# The bundle holds the installer as it is in the repository, and the reference it was given.
archive=$(bash deploy/control-plane/build-bundle.sh 1.2.3 "$reference" "$work/bundle")
[[ $archive == "$work/bundle/shipkeep-control-plane_1.2.3.tar.gz" ]] || die 'unexpected archive name'
tar -tzf "$archive" | sort >"$work/listing"
printf 'shipkeep-control-plane/%s\n' '' .env.example Caddyfile LICENSE NOTICE compose.yml image install.sh | cmp -s - "$work/listing" || die 'unexpected bundle content'
tar -xzf "$archive" -C "$work"
cmp -s "$installer" "$work/shipkeep-control-plane/install.sh" || die 'the bundled installer differs'
[[ -x $work/shipkeep-control-plane/install.sh ]] || die 'the bundled installer is not executable'
read_image "$work/shipkeep-control-plane/image"
[[ $image == "$reference" ]] || die 'the bundle does not carry its image reference'
bash deploy/control-plane/build-bundle.sh 1.2.3 "$reference" "$work/again" >/dev/null
cmp -s "$archive" "$work/again/shipkeep-control-plane_1.2.3.tar.gz" || die 'the bundle is not reproducible'
refused bash deploy/control-plane/build-bundle.sh ../1.2.3 "$reference" "$work/bad" || die 'accepted a version with a path'
refused bash deploy/control-plane/build-bundle.sh 1.2.4 "$reference" "$work/bad" || die 'accepted a tag that is not the version'
refused bash deploy/control-plane/build-bundle.sh 1.2.3 ghcr.io/shipkeepdev/shipkeep:1.2.3 "$work/bad" || die 'accepted a reference without a digest'
[[ ! -e $work/bad ]] || die 'a refused bundle left files behind'
printf 'Control plane installer checks passed.\n'
