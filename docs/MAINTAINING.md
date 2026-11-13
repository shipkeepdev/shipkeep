# Maintaining the repository

Settings and secrets that only maintainers handle. Contributors do not need this page.

```bash
OWNER=shipkeepdev
REPO=shipkeep
```

## Branch protection on `main`

```bash
gh api -X POST "repos/$OWNER/$REPO/rulesets" --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "DCO sign-off" },
          { "context": "TypeScript (lint, test, build)" },
          { "context": "Go (lint, test)" },
          { "context": "Generated code is up to date" },
          { "context": "Integration tests (Postgres, Docker)" },
          { "context": "Semgrep (custom rules + OWASP)" },
          { "context": "gosec" },
          { "context": "Secret scanning" },
          { "context": "Trivy filesystem scan" },
          { "context": "actionlint" },
          { "context": "CodeQL (javascript-typescript)" },
          { "context": "CodeQL (go)" }
        ] } }
  ]
}
JSON
```

Zero required approvals: with one maintainer, GitHub does not let an author approve their own pull request. When a second maintainer joins, raise the count to 1 and enable code owner review.

## Apps and repository settings

- Renovate opens dependency updates (`renovate.json`).
- Private vulnerability reporting is enabled in the repository's security settings.
- CodeRabbit reviews pull requests (ADR 0018, `.coderabbit.yaml`).
- GitHub Discussions takes questions and ideas. The forms are in `.github/DISCUSSION_TEMPLATE/`, named after each category's slug; categories are managed in the web UI.
- Pull requests are squash-merged and their branches deleted.

## CI secrets

Set values yourself; never paste them into a chat or a commit.

| Secret               | Needed from | Purpose                                                                                               | Command                                                                  |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `HCLOUD_TOKEN`       | M10.1       | Create and delete VMs for nightly E2E tests (Hetzner Cloud project dedicated to CI)                   | `gh secret set HCLOUD_TOKEN --repo "$OWNER/$REPO"` (paste when prompted) |
| `HOMEBREW_TAP_TOKEN` | M8.2        | Push the CLI formula to `$OWNER/homebrew-tap` (fine-grained token, contents write on that repo only)  | `gh secret set HOMEBREW_TAP_TOKEN --repo "$OWNER/$REPO"`                 |
| `SCOOP_BUCKET_TOKEN` | M8.2        | Push the CLI manifest to `$OWNER/scoop-bucket` (fine-grained token, contents write on that repo only) | `gh secret set SCOOP_BUCKET_TOKEN --repo "$OWNER/$REPO"`                 |

Signing uses cosign keyless (GitHub OIDC), so no signing key secret is needed. GHCR uses the workflow `GITHUB_TOKEN`.

## Releases

- Tags `vMAJOR.MINOR.PATCH` trigger `release.yml`: agent and CLI binaries (GoReleaser), control plane image on `ghcr.io/$OWNER/shipkeep`, all signed with cosign, SBOM and provenance attached.
- Pre-releases use `-alpha.N`, `-beta.N`, `-rc.N`.
- The image job pushes to the `shipkeep` container package of the organization. That needs three settings, made once: the organization allows public packages (Settings, Packages), the package is public, and the repository has the Write role on it (package settings, Manage Actions access). Without the last one the push fails with `permission_denied: write_package`; fix the setting and rerun the failed job, which also adds the `SHIPKEEP_IMAGE` line to the release notes.
- After a release, run `docs/INSTALL.md` with its published artifacts and update "What has been tested" there.
