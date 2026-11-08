#!/usr/bin/env bash
# Tests check-dco.sh against commits made in a throwaway repository.
set -euo pipefail

check="$(cd "$(dirname "$0")" && pwd)/check-dco.sh"
repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q -b main
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com

commit() { git commit -q --allow-empty --no-verify -m "$@"; }
expect() {
  local want="$1" name="$2" got=0
  "$check" main HEAD >/dev/null || got=1
  if [ "$want" != "$got" ]; then
    echo "FAILED: $name (expected $want, got $got)" >&2
    exit 1
  fi
}
branch() { git checkout -q -B "$1" main; }

commit 'base'

branch signed
commit 'feat: a' -m 'Signed-off-by: Ada <ada@example.com>'
expect 0 'a commit signed off by its author passes'

branch unsigned
commit 'feat: a'
expect 1 'an unsigned commit fails'

branch other
commit 'feat: a' -m 'Signed-off-by: Bob <bob@example.com>'
expect 1 'a sign-off by someone else fails'

branch prose
commit 'feat: a' -m 'Mentions Signed-off-by: Ada <ada@example.com> in the middle of a sentence.'
expect 1 'a sign-off that is not a trailer fails'

branch one-bad
commit 'feat: a' -m 'Signed-off-by: Ada <ada@example.com>'
commit 'feat: b'
expect 1 'one unsigned commit among signed ones fails'

branch bot
GIT_AUTHOR_NAME='renovate[bot]' GIT_AUTHOR_EMAIL='29139614+renovate[bot]@users.noreply.github.com' commit 'chore: update'
expect 0 'a GitHub App bot commit is exempt'

branch merged
commit 'feat: a' -m 'Signed-off-by: Ada <ada@example.com>'
git merge -q --no-ff --no-verify -m 'merge' signed
expect 0 'a merge commit is skipped'

echo 'check-dco: all cases pass'
