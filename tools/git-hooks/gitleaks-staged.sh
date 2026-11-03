#!/usr/bin/env sh
# Scan staged changes for secrets. Blocks the commit on any finding.
# Install gitleaks: https://github.com/gitleaks/gitleaks#installing
set -eu

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed. Install it (https://github.com/gitleaks/gitleaks#installing) or commit with LEFTHOOK=0 only if you are sure no secret is staged." >&2
  exit 1
fi

exec gitleaks git --pre-commit --staged --redact --no-banner --exit-code 1
