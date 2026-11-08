#!/usr/bin/env bash
# Checks that every commit between two revisions is signed off by its author (DCO 1.1).
# Usage: check-dco.sh <base> <head>. Commit metadata is untrusted: it is compared, never printed,
# so a crafted author or message cannot inject workflow commands into the log.
set -euo pipefail

base="$1"
head="$2"
failed=0

while IFS= read -r commit; do
  email="$(git log -1 --format=%ae "$commit")"
  case "$email" in
    *'[bot]@users.noreply.github.com') continue ;;
  esac
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$commit" | grep -Fiq -- "<$email>"; then
    echo "::error::Commit ${commit:0:12} has no Signed-off-by line matching its author. Fix it with: git rebase --signoff origin/main"
    failed=1
  fi
done < <(git rev-list --no-merges "$base..$head")

exit "$failed"
