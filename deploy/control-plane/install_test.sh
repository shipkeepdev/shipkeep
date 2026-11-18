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
for address in owner 'owner@' '@example.com' 'a b@example.com' "owner@example.com'" $'owner@example.com\n--dir' 'owner@example.com;id' "$long@example.com"; do
  refuse 'Invalid email address' --email "$address"
done
refuse 'Invalid SMTP user' --smtp-user $'user\nname'
refuse 'Invalid SMTP user' --smtp-user "$long"
refuse 'Unknown option' --image example.com/other:1
refuse 'Missing option value' --domain
# Email is optional, but its settings come together: a port or a sender without a host is a mistake.
refuse 'Give --smtp-host' --smtp-port 465
refuse 'Give --smtp-host' --smtp-from shipkeep@example.com
refuse 'Give --smtp-host' --smtp-user user@example.com
# The password of the first account is never an option.
refuse 'Unknown option' --password "$secret-long-enough"
# Valid options go as far as the sudo check, and no further without root.
refuse 'Run with sudo' --dir /opt/shipkeep --domain shipkeep.example.com --email owner@example.com --smtp-host smtp.example.com --smtp-port 465 --smtp-from shipkeep@example.com --smtp-user user@example.com
# So does an installation without email, which is the ordinary one.
refuse 'Run with sudo' --domain shipkeep.example.com --email owner@example.com

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
mkdir "$work/interrupted"
: >"$work/interrupted/.env.new"
refused assert_no_installation "$work/interrupted" || die 'a leftover settings draft was accepted'

# A directory that someone other than root can change is refused, and so is anything below it.
refused assert_root_directory "$work/fresh" || die 'a directory of a regular user was accepted'
grep -q 'must belong to root' "$work/output" || die 'a directory of a regular user was refused without saying why'
refused assert_root_directory "$work/absent/deeper" || die 'a path below a directory of a regular user was accepted'
refused assert_root_directory /tmp/shipkeep-absent || die 'a path below a world-writable directory was accepted'
# The cases that need root-owned system directories. Inside some sandboxes root's files appear to
# belong to nobody, and nothing can pass there.
if [[ $(stat -c %u / /usr | tr -d '\n') == 00 ]]; then
  assert_root_directory /usr
  assert_root_directory /usr/shipkeep-absent/deeper
  # A home directory is not writable by others, and still is not root's.
  if [[ -d $HOME && $(stat -c %u "$HOME") != 0 ]]; then
    refused assert_root_directory "$HOME/shipkeep-absent" || die 'a path below a home directory was accepted'
  fi
  refused assert_root_directory /etc/passwd || die 'a file was accepted as the directory'
  grep -q 'is not a directory' "$work/output" || die 'a file was refused without saying why'
  # /bin is a link to usr/bin on a merged-/usr system such as the CI runner.
  link=$(find / -maxdepth 1 -type l -print -quit)
  if [[ -n $link ]]; then
    refused assert_root_directory "$link/shipkeep" || die 'a link above the directory was accepted'
    grep -q 'is a link' "$work/output" || die 'a link above the directory was refused without saying why'
    refused assert_root_directory "$link" || die 'a link was accepted as the directory'
  else
    printf 'Skipped: no link in / to check with.\n' >&2
  fi
else
  printf 'Skipped: root does not own / and /usr here.\n' >&2
fi

# The password of the first account: 15 to 128 characters on one line, asked without echo.
passphrase='a passphrase with spaces, 15+'
valid_owner_password "$passphrase" || die 'a passphrase was refused'
valid_owner_password 'exactly15chars!' || die 'fifteen characters were refused'
valid_owner_password "${long:0:128}" || die 'the longest password was refused'
for bad in '' short 'fourteen chars' "$long$long" $'two lines of a\npassword here' $'a tab\tin the password!'; do
  ! valid_owner_password "$bad" || die "accepted the password: ${bad:0:20}"
done
# From a pipe the line is read once, kept in the variable, and shown nowhere.
owner_password=''
ask_owner_password <<<"$passphrase" 2>"$work/output"
[[ $owner_password == "$passphrase" ]] || die 'the password was not read from the pipe'
! grep -q -- "$passphrase" "$work/output" || die 'the password was shown while it was asked'
grep -q 'input hidden' "$work/output" || die 'the password question does not say the input is hidden'
refused ask_owner_password <<<'short' || die 'a short password from a pipe was accepted'
grep -q '15 to 128 characters' "$work/output" || die 'a short password was refused without saying why'
refused ask_owner_password </dev/null || die 'a missing password was accepted'

# The account is created by the control plane's command line: the address is an argument, the
# password is not. It goes on standard input, where no other process can read it.
(
  docker() {
    printf '%s\n' "$@" >"$work/account-arguments"
    cat >"$work/account-input"
  }
  # The installer's create_first_account reads these.
  # shellcheck disable=SC2034
  owner_email=owner@example.com owner_password=$passphrase
  create_first_account
)
grep -Fxq -- 'owner@example.com' "$work/account-arguments" || die 'the address did not reach the command'
grep -Fxq -- '--email' "$work/account-arguments" || die 'the command was not given --email'
! grep -q -- "$passphrase" "$work/account-arguments" || die 'the password was passed as an argument'
! grep -q -- '^-e$\|^--env' "$work/account-arguments" || die 'a variable was passed to the command'
[[ $(<"$work/account-input") == "$passphrase" ]] || die 'the password did not reach standard input'
tr '\n' ' ' <"$work/account-arguments" | grep -q 'compose --file compose.yml run --rm --no-deps -T control-plane node main.js account create --email owner@example.com' || die 'unexpected account command'
# A refusal by the control plane is the installer's failure too.
(
  docker() {
    cat >/dev/null
    return 1
  }
  # shellcheck disable=SC2034
  owner_email=owner@example.com owner_password=$passphrase
  ! create_first_account
) || die 'a refused account creation was reported as done'

# Only the pinned signing key is installed, whatever else the downloaded file holds.
keys=$work/keys
mkdir -m 0700 "$keys"
for name in first second; do
  gpg --homedir "$keys" --batch --quiet --passphrase '' --quick-generate-key "$name@example.com" ed25519 sign never 2>/dev/null
  gpg --homedir "$keys" --batch --quiet --armor --export "$name@example.com" >"$work/$name.asc"
done
first=$(gpg --homedir "$keys" --batch --with-colons --list-keys first@example.com 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
second=$(gpg --homedir "$keys" --batch --with-colons --list-keys second@example.com 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
[[ ${#first} == 40 && ${#second} == 40 && $first != "$second" ]] || die 'no test keys'
cat "$work/first.asc" "$work/second.asc" >"$work/first-then-second.asc"
cat "$work/second.asc" "$work/first.asc" >"$work/second-then-first.asc"
gpg --homedir "$keys" --batch --quiet --armor --export first@example.com second@example.com >"$work/one-block.asc"
single_signing_key "$work/first.asc" "$work/first.gpg" "$first" || die 'the expected key alone was refused'
# apt is given gpg's own export of that key, never the downloaded bytes.
! grep -q 'BEGIN PGP' "$work/first.gpg" || die 'the downloaded file was installed as it came'
[[ $(gpg --homedir "$keys" --batch --show-keys --with-colons "$work/first.gpg" | grep -c '^pub:') == 1 ]] || die 'the installed keyring does not hold one key'
gpg --homedir "$keys" --batch --show-keys --with-colons "$work/first.gpg" | grep -q "^fpr:.*:$first:" || die 'the installed keyring holds another key'
gpgconf --homedir "$keys" --kill all
for file in second.asc first-then-second.asc second-then-first.asc one-block.asc image missing.asc; do
  refused single_signing_key "$work/$file" "$work/refused.gpg" "$first" || die "accepted the key file $file"
  [[ ! -s $work/refused.gpg ]] || die "a keyring was written from $file"
done

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
# It never writes through something that is already there.
refused write_env "$work/settings/.env" || die 'an existing settings file was overwritten'
ln -s "$work/settings/elsewhere" "$work/settings/.env.new"
refused write_env "$work/settings/.env.new" || die 'the settings were written through a link'
[[ ! -e $work/settings/elsewhere ]] || die 'the settings followed a link'
cp deploy/control-plane/compose.yml deploy/control-plane/Caddyfile "$work/settings/"
docker compose --project-directory "$work/settings" config --quiet
[[ $(grep -c '' "$work/settings/.env") == 10 ]] || die 'unexpected settings file'
# An installation without email (ADR 0020) leaves the mail settings empty: the compose file
# accepts that, hands the control plane an empty host, and keeps the default port.
mkdir "$work/no-email"
# shellcheck disable=SC2034
smtp_host='' smtp_port='' smtp_from='' smtp_user='' smtp_password=''
write_env "$work/no-email/.env"
cp deploy/control-plane/compose.yml deploy/control-plane/Caddyfile "$work/no-email/"
docker compose --project-directory "$work/no-email" config --format json >"$work/no-email/config.json"
grep -q '"SMTP_HOST": ""' "$work/no-email/config.json" || die 'an installation without email does not hand an empty SMTP host'
grep -q '"SMTP_PORT": "465"' "$work/no-email/config.json" || die 'an installation without email lost the default SMTP port'
! grep -q "$secret" "$work/no-email/.env" || die 'a mail password was written for an installation without email'
# The example file stands for that installation too.
cp deploy/control-plane/.env.example "$work/no-email/.env.example"
grep -Eq '^SMTP_HOST=$' "$work/no-email/.env.example" || die 'the example settings still require a mail server'

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
