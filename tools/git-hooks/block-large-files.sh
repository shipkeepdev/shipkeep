#!/usr/bin/env sh
# Block staged files over 1 MB unless .gitattributes marks them as allowed (`shipkeep-large-ok`).
set -eu

LIMIT=1048576
status=0

for file in "$@"; do
  [ -f "$file" ] || continue
  size=$(wc -c <"$file")
  if [ "$size" -gt "$LIMIT" ]; then
    if git check-attr shipkeep-large-ok -- "$file" | grep -q ': set$'; then
      continue
    fi
    echo "$file is $size bytes (limit $LIMIT). Large binaries do not belong in git; if this one is intentional, mark it with 'shipkeep-large-ok' in .gitattributes." >&2
    status=1
  fi
done

exit $status
