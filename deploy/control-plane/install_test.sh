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
for address in owner 'owner@' '@example.com' 'a b@example.com' "owner@example.com'" $'owner@example.com\n--dir' 'owner@example.com;id' "$long@example.com" owner..ops@example.com owner@localhost; do
  refuse 'Invalid email address' --email "$address"
done
refuse 'Invalid SMTP user' --smtp-user $'user\nname'
refuse 'Invalid SMTP user' --smtp-user "$long"
refuse 'Unknown option' --image example.com/other:1
refuse 'Missing option value' --domain
# A resumed run takes its settings from the interrupted one, never from options.
refuse 'Invalid --resume' --resume no
refuse 'Invalid --resume' --resume "yes;id"
refuse 'Give --resume yes with --dir only' --resume yes --domain shipkeep.example.com
refuse 'Give --resume yes with --dir only' --resume yes --smtp-user ''
refuse 'Run with sudo' --resume yes --dir /opt/shipkeep
# Email is optional, but its settings come together: a port or a sender without a host is a mistake.
refuse 'Give --smtp-host' --smtp-port 465
refuse 'Give --smtp-host' --smtp-from shipkeep@example.com
refuse 'Give --smtp-host' --smtp-user user@example.com
# The password of the first account is never an option.
refuse 'Unknown option' --password "$secret-long-enough"
# Without a terminal, standard input holds the password only: it is never read as the answer to
# the single-machine question, which must then come as an option.
refuse 'Without a terminal, give --single-machine yes or no, --domain and --email' --domain shipkeep.example.com --email owner@example.com
refuse 'Without a terminal, give --single-machine yes or no, --domain and --email' --single-machine no --email owner@example.com
refuse 'Without a terminal, give --single-machine yes or no, --domain and --email' --single-machine no --domain shipkeep.example.com
# Valid options go as far as the sudo check, and no further without root.
refuse 'Run with sudo' --single-machine no --dir /opt/shipkeep --domain shipkeep.example.com --email owner@example.com --smtp-host smtp.example.com --smtp-port 465 --smtp-from shipkeep@example.com --smtp-user user@example.com
# So does an installation without email, which is the ordinary one, on one machine or two.
refuse 'Run with sudo' --single-machine yes --organization 'Acme Corp' --domain shipkeep.example.com --email owner@example.com
refuse 'Run with sudo' --single-machine no --domain shipkeep.example.com --email owner@example.com

# The remaining checks call the installer's own functions.
# shellcheck source=/dev/null
. "$installer"
refused() { ! ("$@") 2>"$work/output"; }

# A question without a terminal reads no line: the line would be a password. A password shaped like
# an answer (here a valid DNS name) is neither taken nor printed back. The line comes from a file
# whose offset the subshell shares, so a line read there is gone for the read below.
printf '%s\n' 'a.password.shaped.like.a.name' >"$work/line"
for question in 'domain DNS valid_domain Invalid --domain' 'organization Name valid_organization Invalid --organization' 'smtp_from Sender valid_address Invalid --smtp-from'; do
  read -r name label check error option <<<"$question"
  printf -v "$name" '%s' ''
  exec 3<"$work/line"
  refused ask "$name" "$label" "$check" "$error" "$option" <&3 || die "$name was read without a terminal"
  grep -qF -- "Without a terminal, give $option" "$work/output" || die "$name was refused without naming $option: $(cat "$work/output")"
  ! grep -q 'password.shaped' "$work/output" || die "the line read for $name was printed"
  IFS= read -r left <&3 || left=''
  exec 3<&-
  [[ $left == a.password.shaped.like.a.name ]] || die "the line was read for $name"
done

# shellcheck source=/dev/null
. deploy/docker-repository-test.sh
check_docker_repository "$installer" "$work/apt"

mkdir "$work/fresh" "$work/installed" "$work/linked"
assert_no_installation "$work/fresh"
: >"$work/installed/.env"
ln -s /nonexistent "$work/linked/.env"
refused assert_no_installation "$work/installed" || die 'an existing settings file was accepted'
grep -q 'Existing installation' "$work/output" || die 'an existing settings file was refused without saying why'
grep -q -- '--resume yes' "$work/output" || die 'the refusal did not say how to finish an interrupted installation'
refused assert_no_installation "$work/linked" || die 'a dangling link was accepted'
# A run stopped before .env started nothing: its other files are replaced by the next run.
mkdir "$work/interrupted"
: >"$work/interrupted/.env.new"
: >"$work/interrupted/install-state"
: >"$work/interrupted/compose.yml"
assert_no_installation "$work/interrupted" || die 'a run stopped before its settings file cannot be retried'

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

# An address the installer accepts is one the control plane accepts: a refusal after the stack
# is started would leave an installation without its first account.
for address in owner@example.com First.Last+tag@sub.example.co o_wner%x-y@a-b.example.com "${long:0:64}@example.com"; do
  valid_address "$address" || die "refused the address $address"
done
for address in owner..ops@example.com .owner@example.com owner.@example.com owner@example owner@-a.example.com owner@a-.example.com owner@a..example.com owner@.example.com owner@example.com. "o'hara@example.com" "${long:0:65}@example.com" 'owner@exam ple.com' owner@@example.com; do
  ! valid_address "$address" || die "accepted the address $address"
done

# The password of the first account: 15 to 128 characters on one line, asked without echo.
passphrase='a passphrase with spaces, 15+'
valid_owner_password "$passphrase" || die 'a passphrase was refused'
valid_owner_password 'exactly15chars!' || die 'fifteen characters were refused'
valid_owner_password "${long:0:128}" || die 'the longest password was refused'
for bad in '' short 'fourteen chars' "${long:0:129}" "$long$long" $'two lines of a\npassword here' $'a tab\tin the password!'; do
  ! valid_owner_password "$bad" || die "accepted the password: ${bad:0:20}"
done
# Characters are counted as the control plane counts them, whatever their size in bytes: two
# bytes (é), three (€), four (an emoji). Fifteen and 128 pass; fourteen and 129 do not.
repeat() { local out='' i; for ((i = 0; i < $2; i++)); do out+=$1; done; printf '%s' "$out"; }
for character in é € 😀; do
  valid_owner_password "$(repeat "$character" 15)" || die "refused fifteen times $character"
  valid_owner_password "$(repeat "$character" 128)" || die "refused 128 times $character"
  ! valid_owner_password "$(repeat "$character" 14)" || die "accepted fourteen times $character"
  ! valid_owner_password "$(repeat "$character" 129)" || die "accepted 129 times $character"
done
valid_owner_password 'un mot de passe accentué' || die 'a passphrase with an accent was refused'
# Only UTF-8 text: the control plane refuses anything else, and must not see it after the stack
# is started. Stray continuation bytes would also make the count above wrong.
valid_owner_password $'\xef\xbb\xbfa long passphrase \xed\x9f\xbf\xee\x80\x80\xf4\x8f\xbf\xbf' || die 'valid UTF-8 at the edges of its ranges was refused'
for bad in "abcdefghijklmno$(repeat $'\x80' 114)" $'a passphrase in latin-1: \xe9t\xe9' $'a long passphrase \xc0\xa9' $'a long passphrase \xc1\xbf' \
  $'a long passphrase \xe0\x9f\xbf' $'a long passphrase \xf0\x8f\xbf\xbf' $'a long passphrase \xed\xa0\x80' $'a long passphrase \xf4\x90\x80\x80' \
  $'a long passphrase \xf5\x80\x80\x80' $'a long passphrase \xff' $'a long passphrase \xe2\x82' $'a long \xe2\x82passphrase'; do
  ! valid_owner_password "$bad" || die "accepted a password that is not UTF-8: $(printf '%q' "${bad:0:24}")"
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
# A file saved with CRLF line ends gives the same password; a CR inside the line is refused.
# (In a subshell: a refusal ends the installer's run, and would end these checks without a word.)
crlf=$(
  ask_owner_password < <(printf '%s\r\n' "$passphrase") 2>/dev/null
  printf '%s' "$owner_password"
) || die 'a password line ending with CRLF was refused'
[[ $crlf == "$passphrase" ]] || die 'a password line ending with CRLF was not read as the control plane reads it'
# A CR at the very end of the input is a line end too (old Mac files), as the command reads it:
# a password never holds a CR, so it cannot be cut short. Both sides must agree on the password.
crlf=$(
  ask_owner_password < <(printf '%s\r' "$passphrase") 2>/dev/null
  printf '%s' "$owner_password"
) || die 'a password line ending with CR and no LF was refused'
[[ $crlf == "$passphrase" ]] || die 'a password line ending with CR and no LF was not read as the control plane reads it'
refused ask_owner_password < <(printf 'a passphrase with\r a CR inside\n') || die 'a password with a CR inside was accepted'
grep -q 'without tabs or other control characters' "$work/output" || die 'a password with a control character was refused without saying why'
refused ask_owner_password < <(printf '%s\r\r\n' "$passphrase") || die 'a password ending with two CRs was accepted'
# A last line without its line end is read whole, and so are bytes above ASCII.
owner_password=''
ask_owner_password < <(printf 'un mot de passe accentué €') 2>/dev/null
[[ $owner_password == 'un mot de passe accentué €' ]] || die 'a piped password was changed on the way'
# Only that line is taken: the next one stays for the next question.
owner_password='' next=''
{
  ask_owner_password 2>/dev/null
  IFS= read -r next
} < <(printf '%s\nthe next answer\n' "$passphrase")
[[ $owner_password == "$passphrase" && $next == 'the next answer' ]] || die 'the password question read more than its line'
# A NUL byte cannot be kept in a variable: the line is refused, never shortened into another
# password. (Text saved as UTF-16 is full of them.)
refused ask_owner_password < <(printf 'a passphrase with\0 a NUL byte in it\n') || die 'a password with a NUL byte was accepted'
grep -q 'NUL byte' "$work/output" || die 'a password with a NUL byte was refused without saying why'
! grep -q 'a passphrase with' "$work/output" || die 'a refused password was shown'
refused ask_owner_password < <(printf 'p\0a\0s\0s\0p\0h\0r\0a\0s\0e\0 \0l\0o\0n\0g\0 \0e\0n\0o\0u\0g\0h\0\n\0') || die 'a UTF-16 password was accepted'
# A line that is not UTF-8 is refused with its own reason, not as a length.
refused ask_owner_password < <(printf 'a passphrase in latin-1: \351t\351\n') || die 'a Latin-1 password was accepted'
grep -q 'not UTF-8 text' "$work/output" || die 'a Latin-1 password was refused without saying why'
# A line longer than any secret is refused as soon as it is too long: the reader stops there
# instead of taking in whatever is sent (5000 bytes here, 4097 read).
rest=''
{
  refused ask_owner_password || die 'an endless password line was accepted'
  IFS= read -r rest || true
} < <(printf '%s\n' "$(repeat a 5000)")
[[ ${#rest} == 903 ]] || die "the password question kept reading a line that was already too long (${#rest} bytes left)"

# The installer starts from its own variables. A name inherited from the environment would stay
# exported once assigned, and reach every child process with the password; and Docker Compose
# would prefer an inherited variable to the settings file the installer writes.
(
  export owner_password=inherited smtp_password=inherited admin_password=inherited app_password=inherited
  export SHIPKEEP_IMAGE=example.com/other:1 SHIPKEEP_DOMAIN=other.example.com POSTGRES_ADMIN_PASSWORD=x POSTGRES_APP_PASSWORD=x
  export SMTP_HOST=other.example.com SMTP_PORT=25 SMTP_FROM=other@example.com SMTP_USER=other SMTP_PASSWORD=other
  export COMPOSE_FILE=/elsewhere.yml COMPOSE_ENV_FILES=/elsewhere.env COMPOSE_PROJECT_NAME=other COMPOSE_PROFILES=other
  export COMPOSE_DISABLE_ENV_FILE=1 COMPOSE_REMOVE_ORPHANS=1
  own_variables
  # What the installer then does with these names.
  # shellcheck disable=SC2034
  owner_password=$passphrase smtp_password=$secret admin_password=$secret app_password=$secret
  env >"$work/child-environment"
)
! grep -q -- "$passphrase\|$secret" "$work/child-environment" || die 'a password reached the environment of child processes'
! grep -Eq '^(owner_password|smtp_password|admin_password|app_password|SHIPKEEP_IMAGE|SHIPKEEP_DOMAIN|POSTGRES_ADMIN_PASSWORD|POSTGRES_APP_PASSWORD|SMTP_HOST|SMTP_PORT|SMTP_FROM|SMTP_USER|SMTP_PASSWORD|COMPOSE_[A-Z_]*)=' "$work/child-environment" || die 'an inherited variable would override the settings of the installation'

# The account is created by the control plane's command line: the address is an argument, the
# password is not. It goes on standard input, where no other process can read it.
(
  # Stands in for Docker: the installer's compose function calls it.
  # shellcheck disable=SC2329
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
  # shellcheck disable=SC2329
  docker() {
    cat >/dev/null
    return 1
  }
  # shellcheck disable=SC2034
  owner_email=owner@example.com owner_password=$passphrase
  ! create_first_account
) || die 'a refused account creation was reported as done'

# ADR 0021 on one machine: the server installer's system, a Compose that reads !override, and an
# Engine that keeps ports published on 127.0.0.1 to this machine.
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$work/noble"
printf 'ID=debian\nVERSION_ID="12"\n' >"$work/bookworm"
printf 'ID=ubuntu\nVERSION_ID="22.04"\n' >"$work/jammy"
ubuntu_noble "$work/noble" || die 'Ubuntu 24.04 was refused'
for file in bookworm jammy missing; do
  refused ubuntu_noble "$work/$file" || die "accepted the system of $file"
done
for version in 2.24.4 v2.24.4 2.24.10 2.25.0 2.40.3 v5.7.0 2.24.4-desktop.1 3.0.0; do
  compose_reads_override "$version" || die "Compose $version was refused"
done
for version in 2.24.3 v2.24.3 2.9.99 1.29.2 2.24 '' v 'x2.30.0' '2.30.0;id' '99999.0.0'; do
  refused compose_reads_override "$version" || die "Compose '$version' was accepted"
done
for version in 28.0.0 28.5.1 29.1.3 30.0.0-rc.1; do
  engine_keeps_loopback "$version" || die "Docker Engine $version was refused"
done
for version in 27.5.1 20.10.24 26.1.4-ce '' '28' '28.0.0;id'; do
  refused engine_keeps_loopback "$version" || die "Docker Engine '$version' was accepted"
done

# Organization ids are tenant ids: UUIDv7, ordered by time.
for _ in 1 2 3 4 5 6 7 8; do
  generated=$(new_uuid7)
  [[ $generated =~ ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die "not a UUIDv7: $generated"
done
stamp=${generated:0:8}${generated:9:4}
# Within a minute of now. A second ahead is allowed: a CI runner's clock was seen stepping back
# 0.8 s between the id and this check, which says nothing about the id.
now=$(date +%s%3N)
((10#$now - 16#$stamp < 60000 && 16#$stamp <= 10#$now + 1000)) || die "the UUIDv7 does not hold the current time: $generated"

# install-state: what --resume yes reads back, and nothing else.
state=$work/state
mkdir "$state"
read_back() (
  # shellcheck disable=SC2034
  directory=$state single=0 compose_files='-f compose.yml' domain='' owner_email='' organization='' organization_id='' started=0 account_done=0 organization_done=0 server_done=0 sends_email=0
  read_state "$state/install-state"
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$single" "$compose_files" "$domain" "$owner_email" "$organization" "$organization_id" "$started" "$account_done" "$organization_done" "$server_done" "$sends_email"
)
uuid=0190a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b
printf 'mode=single\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=smtp\norganization=Acme Corp\nstarted\naccount\norganization_id=%s\norganization_created\n' "$uuid" >"$state/install-state"
[[ $(read_back) == "1|-f compose.yml -f compose.single-machine.yml|shipkeep.example.com|owner@example.com|Acme Corp|$uuid|1|1|1|0|1" ]] || die "install-state was not read back: $(read_back)"
printf 'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=none\n' >"$state/install-state"
[[ $(read_back) == '0|-f compose.yml|shipkeep.example.com|owner@example.com||||0|0|0|0|0' || $(read_back) == '0|-f compose.yml|shipkeep.example.com|owner@example.com|||0|0|0|0|0' ]] || die "a separate install-state was not read back: $(read_back)"
# A separate machine that runs an agent (ADR 0028) recorded its first organization too.
printf 'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=none\norganization=Acme Corp\n' >"$state/install-state"
[[ $(read_back) == '0|-f compose.yml|shipkeep.example.com|owner@example.com|Acme Corp||0|0|0|0|0' ]] || die "a separate install-state with an agent was not read back: $(read_back)"
# shellcheck disable=SC2016
for bad in 'mode=single\ndomain=shipkeep.example.com\nemail=owner@example.com\n' \
  'mode=separate\ndomain=shipkeep.example.com\n' \
  'mode=separate\nmode=single\ndomain=shipkeep.example.com\nemail=owner@example.com\n' \
  'mode=separate\ndomain=$(id).example.com\nemail=owner@example.com\n' \
  'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nCOMPOSE_FILE=/etc/x.yml\n' \
  'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=sometimes\n' \
  'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\norganization_id=../../etc\n' \
  'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\norganization_created=yes\n' \
  'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nstarted;id\n'; do
  # shellcheck disable=SC2059
  printf "$bad" >"$state/install-state"
  refused read_back || die "accepted the install-state: $bad"
done
printf 'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\n' >"$work/real-state"
rm -f "$state/install-state"
ln -s "$work/real-state" "$state/install-state"
refused read_back || die 'accepted an install-state that is a link'
rm -f "$state/install-state"
refused read_back || die 'resumed without an install-state'
{ printf 'mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\n'; repeat 'started\n' 600 | sed 's/\\n/\n/g'; } >"$state/install-state"
refused read_back || die 'accepted an oversized install-state'

# The steps a resumed run takes, with the commands of Docker and of the server installer replaced:
# $1 is the state left by the interrupted run, the other arguments set the stand-ins' answers.
resume_with() (
  local account_status=$2 server_state=$3 organization_status=$4
  # shellcheck disable=SC2034
  directory=$state here="$work/Release Files" single=0 compose_files='-f compose.yml' domain='' owner_email='' organization='' organization_id='' started=0 account_done=0 organization_done=0 server_done=0 sends_email=0 owner_password='' writing=0
  printf '%b' "$1" >"$state/install-state"
  read_state "$state/install-state"
  : >"$work/resume-calls"
  # shellcheck disable=SC2329
  compose() { printf 'compose %s\n' "$*" >>"$work/resume-calls"; }
  # shellcheck disable=SC2329
  ask_owner_password() { owner_password=asked; }
  # shellcheck disable=SC2329
  create_first_account() { printf 'account\n' >>"$work/resume-calls"; return "$account_status"; }
  # shellcheck disable=SC2329
  create_organization() { printf 'organization %s\n' "$organization_id" >>"$work/resume-calls"; return "$organization_status"; }
  # shellcheck disable=SC2329
  this_server_installed() { return "$server_state"; }
  # shellcheck disable=SC2329
  add_this_server() { printf 'server %s\n' "$organization_id" >>"$work/resume-calls"; }
  # shellcheck disable=SC2329
  https_answers() { return 0; }
  # shellcheck disable=SC2329
  controlplane_slice() { printf 'slice\n' >>"$work/resume-calls"; }
  trap unfinished EXIT
  : >"$state/.env"
  finish
)
single_state='mode=single\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=smtp\norganization=Acme Corp\nstarted\n'

# Stopped after the account was committed: the account is kept, never created a second time.
resume_with "$single_state" 3 1 0 >"$work/resume-output" 2>&1 || die "a resume over an existing account failed: $(<"$work/resume-output")"
grep -q 'already exists: it is kept' "$work/resume-output" || die 'the existing account was not said to be kept'
grep -qx account "$state/install-state" || die 'the kept account was not recorded'
chosen=$(sed -n 's/^organization_id=//p' "$state/install-state")
[[ $chosen =~ ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die "no UUIDv7 organization id was chosen and recorded: $chosen"
[[ $(<"$work/resume-calls") == "slice"$'\n'"compose up -d"$'\n'"account"$'\n'"organization $chosen"$'\n'"server $chosen" ]] || die "unexpected resumed steps: $(<"$work/resume-calls")"
[[ $(tail -n 3 "$state/install-state") == "organization_id=$chosen"$'\n'"organization_created"$'\n'"server" ]] || die 'the resumed steps were not recorded in order'
grep -q 'Other people sign up by themselves' "$work/resume-output" || die 'a resumed installation that sends email said it sends none'
grep -q 'Shipkeep is running at https://shipkeep.example.com' "$work/resume-output" || die 'the resumed run did not finish'
# Another refusal of the account stops the run before the organization.
resume_with "$single_state" 1 1 0 >"$work/resume-output" 2>&1 && die 'a refused account was reported as done'
! grep -q '^organization' "$work/resume-calls" || die 'the run went on after a refused account'

# Stopped after the organization id was recorded: the same id is used again, so that the command
# finds the organization the first run committed.
resume_with "${single_state}account\norganization_id=$uuid\n" 0 1 0 >"$work/resume-output" 2>&1 || die "a resume with a recorded organization id failed: $(<"$work/resume-output")"
[[ $(<"$work/resume-calls") == "slice"$'\n'"compose up -d"$'\n'"organization $uuid"$'\n'"server $uuid" ]] || die "the recorded organization id was not reused: $(<"$work/resume-calls")"

# The server installer finished before the run stopped: its installation is recorded, not repeated.
resume_with "${single_state}account\norganization_id=$uuid\norganization_created\n" 0 0 0 >"$work/resume-output" 2>&1 || die "a resume over a finished server install failed: $(<"$work/resume-output")"
[[ $(<"$work/resume-calls") == "slice"$'\n'"compose up -d" ]] || die "the server installer ran again: $(<"$work/resume-calls")"
grep -qx server "$state/install-state" || die 'the finished server install was not recorded'
# An installation that is not this one's stops the run, with what to do.
resume_with "${single_state}account\norganization_id=$uuid\norganization_created\n" 0 2 0 >"$work/resume-output" 2>&1 && die 'an installation of another control plane was accepted'
grep -q 'Starting over' "$work/resume-output" || die 'the foreign installation was refused without saying what to do'
! grep -qx server "$state/install-state" || die 'a foreign installation was recorded'
# A failed step is not recorded, and the message gives the exact command, quoted for the shell.
grep -q -- "sudo bash $work/Release\\\\ Files/install.sh --dir $state --resume yes" "$work/resume-output" || die "the failure did not say how to finish: $(<"$work/resume-output")"
resume_with "${single_state}account\n" 0 1 1 >"$work/resume-output" 2>&1 && die 'a failed organization was reported as done'
! grep -qx organization_created "$state/install-state" || die 'a failed organization was recorded'
# A separate machine that runs an agent (ADR 0028): the organization and the agent, no slice.
separate_state='mode=separate\ndomain=shipkeep.example.com\nemail=owner@example.com\nemail_mode=none\n'
resume_with "${separate_state}organization=Acme Corp\nstarted\naccount\n" 0 1 0 >"$work/resume-output" 2>&1 || die "a separate resume with an agent failed: $(<"$work/resume-output")"
chosen=$(sed -n 's/^organization_id=//p' "$state/install-state")
[[ $(<"$work/resume-calls") == "compose up -d"$'\n'"organization $chosen"$'\n'"server $chosen" ]] || die "unexpected separate steps: $(<"$work/resume-calls")"
grep -q 'This machine runs an agent of the organization Acme Corp' "$work/resume-output" || die 'the agent of a separate machine was not said'
# Its unfinished agent is removed as the agent part, not as a server's.
resume_with "${separate_state}organization=Acme Corp\nstarted\naccount\norganization_id=$uuid\norganization_created\n" 0 2 0 >"$work/resume-output" 2>&1 && die 'an unfinished agent of a separate machine was accepted'
grep -q 'Remove its agent part' "$work/resume-output" || die "the separate machine was told to remove a server part: $(<"$work/resume-output")"
# Without an agent (another system than Ubuntu 24.04), neither.
resume_with "${separate_state}started\naccount\n" 0 1 0 >"$work/resume-output" 2>&1 || die "a separate resume without an agent failed: $(<"$work/resume-output")"
[[ $(<"$work/resume-calls") == "compose up -d" ]] || die "a machine without an agent got one: $(<"$work/resume-calls")"
! grep -q 'runs an agent' "$work/resume-output" || die 'an agent was said on a machine without one'

# What an earlier run of the server installer left, read from a tree that stands in for /.
server=$work/server
# $1 is 0 for a separate machine, and by default 1, a single machine.
installed() (
  # shellcheck disable=SC2034
  domain=shipkeep.example.com organization_id=$uuid single=${1:-1}
  status=0
  this_server_installed "$server" || status=$?
  printf '%s' "$status"
)
mkdir -p "$server/etc/shipkeep" "$server/var/lib/shipkeep" "$server/etc/systemd/system"
[[ $(installed) == 1 ]] || die 'a machine without a server installation was not seen as such'
printf "control_plane:\n  address: 'shipkeep.example.com:7443'\n  connect: '127.0.0.1:7443'\n  route:\n    host: 'shipkeep.example.com'\n    upstream: '127.0.0.1:3000'\n" >"$server/etc/shipkeep/agent.yaml"
: >"$server/etc/systemd/system/shipkeep-agent.service"
: >"$server/etc/shipkeep/join-token"
# The server installer stopped before enabling its services: unfinished, not done.
[[ $(installed) == 2 ]] || die 'an unfinished server installation was taken as done'
mkdir -p "$server/etc/systemd/system/multi-user.target.wants"
for unit in shipkeep-agent shipkeep-caddy; do
  ln -s "/etc/systemd/system/$unit.service" "$server/etc/systemd/system/multi-user.target.wants/$unit.service"
done
[[ $(installed) == 2 ]] || die 'a server installation without its egress proxy was taken as done'
ln -s /etc/systemd/system/shipkeep-egress.service "$server/etc/systemd/system/multi-user.target.wants/shipkeep-egress.service"
[[ $(installed) == 0 ]] || die 'an installation waiting to enroll was not recognized'
printf '{"node_id":"n","organization_id":"%s"}' "$uuid" >"$server/var/lib/shipkeep/credentials.json"
[[ $(installed) == 0 ]] || die 'an enrolled installation was not recognized'
printf '{"organization_id":"0190a8f2-1c2d-7e3f-8a9b-ffffffffffff"}' >"$server/var/lib/shipkeep/credentials.json"
[[ $(installed) == 2 ]] || die 'an agent of another organization was accepted'
printf '{"organization_id":"%s"}' "$uuid" >"$server/var/lib/shipkeep/credentials.json"
sed -i 's/shipkeep.example.com:7443/other.example.com:7443/' "$server/etc/shipkeep/agent.yaml"
[[ $(installed) == 2 ]] || die 'an agent of another control plane was accepted'
rm "$server/etc/shipkeep/agent.yaml"
ln -s "$work/real-state" "$server/etc/shipkeep/agent.yaml"
[[ $(installed) == 2 ]] || die 'an agent configuration that is a link was accepted'
rm "$server/etc/shipkeep/agent.yaml"
[[ $(installed) == 2 ]] || die 'a unit without its configuration was accepted'
# A separate machine: the agent alone, with the control-plane-only role, and no route.
separate_installed() { installed 0; }
rm -rf "$server"
mkdir -p "$server/etc/shipkeep" "$server/var/lib/shipkeep" "$server/etc/systemd/system/multi-user.target.wants"
[[ $(separate_installed) == 1 ]] || die 'a separate machine without an agent was not seen as such'
printf "control_plane:\n  address: 'shipkeep.example.com:7443'\n  connect: '127.0.0.1:7443'\nnode:\n  role: control-plane-only\n" >"$server/etc/shipkeep/agent.yaml"
: >"$server/etc/systemd/system/shipkeep-agent.service"
: >"$server/etc/shipkeep/join-token"
[[ $(separate_installed) == 2 ]] || die 'an agent not enabled yet was taken as done'
ln -s /etc/systemd/system/shipkeep-agent.service "$server/etc/systemd/system/multi-user.target.wants/shipkeep-agent.service"
[[ $(separate_installed) == 0 ]] || die 'the agent of a separate machine was not recognized'
sed -i 's/role: control-plane-only/role: server/' "$server/etc/shipkeep/agent.yaml"
[[ $(separate_installed) == 2 ]] || die 'a server installation was taken for the agent of a separate machine'
sed -i 's/role: server/role: control-plane-only/' "$server/etc/shipkeep/agent.yaml"
[[ $(installed 1) == 2 ]] || die 'an agent without Caddy or route was taken for a single machine'
# Without an agent (another system, or an older Docker), the separate form is the control plane
# alone, and --organization creates nothing.
(
  # shellcheck disable=SC2034
  agent=1 organization='Acme Corp'
  without_agent 'This system is not Ubuntu 24.04 with systemd' 2>"$work/without"
  [[ $agent == 0 && -z $organization ]] || die 'a machine without an agent kept its organization'
  grep -q 'installed without an agent of its own' "$work/without" || die 'the missing agent was not said'
) || exit 1
# The agent pins Docker API 1.47.
for version in 1.47 1.48 1.100; do docker_api_for_agent "$version" || die "refused the Docker API $version"; done
for version in '' 1.46 1.9 2 v1.47 '1.47 ' $'1.47\n' 1.47.0; do
  refused docker_api_for_agent "$version" || die "accepted the Docker API $version"
done

# A run stopped before its settings file says to run again, not to resume.
(
  # shellcheck disable=SC2034
  directory=$work/no-settings writing=1 here=$work
  mkdir -p "$directory"
  unfinished
) 2>"$work/early-stop"
grep -q 'Run the installer again' "$work/early-stop" || die 'a run stopped before .env did not say to run again'
! grep -q -- '--resume' "$work/early-stop" || die 'a run stopped before .env pointed at --resume'

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
cp deploy/control-plane/compose.yml deploy/control-plane/Caddyfile deploy/control-plane/registry.yml "$work/settings/"
docker compose --project-directory "$work/settings" config --quiet
[[ $(grep -c '' "$work/settings/.env") == 10 ]] || die 'unexpected settings file'
# An installation without email (ADR 0020) leaves the mail settings empty: the compose file
# accepts that, hands the control plane an empty host, and keeps the default port.
mkdir "$work/no-email"
# shellcheck disable=SC2034
smtp_host='' smtp_port='' smtp_from='' smtp_user='' smtp_password=''
write_env "$work/no-email/.env"
cp deploy/control-plane/compose.yml deploy/control-plane/Caddyfile deploy/control-plane/registry.yml "$work/no-email/"
docker compose --project-directory "$work/no-email" config --format json >"$work/no-email/config.json"
grep -q '"SMTP_HOST": ""' "$work/no-email/config.json" || die 'an installation without email does not hand an empty SMTP host'
grep -q '"SMTP_PORT": "465"' "$work/no-email/config.json" || die 'an installation without email lost the default SMTP port'
# The registry (ADR 0030) trusts the control plane's token endpoint for the installation's name,
# reads the key the control plane writes, and starts once the control plane is healthy.
grep -q '"REGISTRY_AUTH_TOKEN_REALM": "https://shipkeep.example.com/api/v1/registry/token"' "$work/no-email/config.json" || die 'the registry does not name the token endpoint'
grep -q '"REGISTRY_AUTH_TOKEN_SERVICE": "shipkeep.example.com"' "$work/no-email/config.json" || die 'the registry does not name the installation'
grep -q '"REGISTRY_JWKS_FILE": "/var/lib/shipkeep-registry/jwks.json"' "$work/no-email/config.json" || die 'the control plane does not write the registry key'
! grep -q "$secret" "$work/no-email/.env" || die 'a mail password was written for an installation without email'
for name in SMTP_HOST SMTP_PORT SMTP_FROM SMTP_USER SMTP_PASSWORD; do
  grep -Fxq -- "$name=\"\"" "$work/no-email/.env" || die "an installation without email does not leave $name empty"
done
# The example file stands for that installation too.
cp deploy/control-plane/.env.example "$work/no-email/.env.example"
grep -Eq '^SMTP_HOST=$' "$work/no-email/.env.example" || die 'the example settings still require a mail server'

# The bundle holds the installer as it is in the repository, and the reference it was given.
archive=$(bash deploy/control-plane/build-bundle.sh 1.2.3 "$reference" "$work/bundle")
[[ $archive == "$work/bundle/shipkeep-control-plane_1.2.3.tar.gz" ]] || die 'unexpected archive name'
tar -tzf "$archive" | sort >"$work/listing"
printf 'shipkeep-control-plane/%s\n' '' .env.example Caddyfile LICENSE NOTICE backup.sh compose.single-machine.yml compose.yml image install.sh registry.yml | cmp -s - "$work/listing" || die 'unexpected bundle content'
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
# Single machine (ADR 0021): the answers and the slug of the first organization.
for answer in yes no y n; do valid_yes_no "$answer" || die "refused the answer $answer"; done
for answer in '' Yes oui 'yes ' $'yes\n' maybe; do refused valid_yes_no "$answer" || die "accepted the answer $answer"; done
valid_organization 'Atelier Nord' || die 'refused an organization name'
valid_organization "$(printf 'a%.0s' {1..80})" || die 'refused 80 characters'
# shellcheck disable=SC2016
for name in '' ' Atelier' 'Atelier ' "$(printf 'a%.0s' {1..81})" $'Atelier\nNord' $'Atelier\tNord' 'Café'; do
  refused valid_organization "$name" || die "accepted the organization name $name"
done
[[ $(organization_slug 'Atelier Nord') == atelier-nord ]] || die 'slug of Atelier Nord'
[[ $(organization_slug '  ACME -- Corp!!  ') == acme-corp ]] || die "slug of ACME: $(organization_slug '  ACME -- Corp!!  ')"
[[ $(organization_slug '42 Labs') == org-42-labs ]] || die 'a slug must start with a letter'
[[ $(organization_slug "$(printf 'ab-%.0s' {1..30})") =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die 'a long slug'
[[ $(organization_slug "$(printf 'ab-%.0s' {1..30})") != *- ]] || die 'a slug ends with a hyphen'
printf 'cgroup2 /sys/fs/cgroup cgroup2 rw,nsdelegate,memory_recursiveprot 0 0\n' >"$work/mounts"
cgroup2_recursiveprot "$work/mounts" || die 'memory_recursiveprot not found'
printf 'cgroup2 /sys/fs/cgroup cgroup2 rw,nsdelegate 0 0\n' >"$work/mounts"
refused cgroup2_recursiveprot "$work/mounts" || die 'accepted cgroup v2 without memory_recursiveprot'
printf 'MemTotal:        4028292 kB\n' >"$work/meminfo"
[[ $(memory_total_bytes "$work/meminfo") == 4124971008 ]] || die 'memory misread'
# The same values as the server installer, which writes the agent's half of the reservation.
grep -qxF 'reserved_memory_bytes=1073741824' deploy/install.sh || die 'the installers reserve different memory'
grep -qxF 'minimum_memory_bytes=3221225472' deploy/install.sh || die 'the installers need different memory'
# Refused single-machine answers stop before anything is asked or changed.
for options in '--single-machine maybe' "--single-machine yes --organization $(printf 'a%.0s' {1..81})"; do
  # shellcheck disable=SC2086 # the options are words on purpose
  if bash "$installer" $options </dev/null >"$work/output" 2>&1; then die "accepted $options"; fi
  grep -Eq 'single-machine|organization name' "$work/output" || die "refused $options for another reason: $(cat "$work/output")"
done
# The registry receives only nothing or one bounded bearer token (#543): the Caddyfile, run by the
# Caddy that Compose pins. There is no registry or API behind it here, so what passes answers 502.
caddy_test=shipkeep-caddyfile-test-$$
docker run -d --rm --name "$caddy_test" -e SHIPKEEP_DOMAIN=http://localhost:8080 \
  -v "$PWD/deploy/control-plane/Caddyfile:/etc/caddy/Caddyfile:ro" \
  --entrypoint timeout "$probe" 120 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
answer() {
  local path=$1
  shift
  docker exec "$caddy_test" wget -q -S -O /dev/null "$@" "http://localhost:8080$path" 2>&1 |
    sed -n 's/^ *HTTP\/[0-9.]* \([0-9]*\).*/\1/p' | head -1
}
for _ in $(seq 1 30); do [[ -n $(answer /v2/) ]] && break; sleep 1; done
segment() { printf 'A%.0s' $(seq "$1"); }
ours="Bearer $(segment 110).$(segment 470).$(segment 86)"
[[ $(answer /v2/) == 502 ]] || die 'a request without a token did not reach the registry'
[[ $(answer /v2/acme/app/manifests/1 --header "Authorization: $ours") == 502 ]] || die 'a token of ours did not reach the registry'
[[ $(answer /v2/ --header "Authorization: Bearer $(segment 513).$(segment 470).$(segment 86)") == 401 ]] || die 'an oversized token header reached the registry'
[[ $(answer /v2/ --header 'Authorization: Bearer {"protected":"x","payload":"x","signature":"x"}') == 401 ]] || die 'a JSON token reached the registry'
[[ $(answer /v2/ --header 'Authorization: Basic dXNlcjpwYXNz') == 401 ]] || die 'basic credentials reached the registry'
[[ $(answer /v2/ --header "Authorization: $ours" --header "Authorization: $ours") == 401 ]] || die 'two tokens reached the registry'
[[ $(answer /api/v1/ready --header "Authorization: Bearer $(segment 600).x.y") == 502 ]] || die 'the filter reaches beyond the registry'
docker rm -f "$caddy_test" >/dev/null 2>&1 || true

printf 'Control plane installer checks passed.\n'
