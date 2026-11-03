# GitHub Setup

Steps marked **[human]** must be done by the maintainer. Steps marked **[claude]** can be run by Claude Code with the `gh` CLI. Run them in order.

```bash
OWNER=samuelmbabhazi  # GitHub account that hosts the repo (the shipkeephq organization does not exist yet; transfer later if created).
REPO=shipkeep
```

## 1. Organization and plan [human]

1. Create the organization `$OWNER` on GitHub (Settings, Organizations, New organization).
2. Plan: branch protection and rulesets on **private** repositories require GitHub Team (paid). On the Free plan the only safeguard is the "never push to main" rule in CLAUDE.md. Recommended: GitHub Team until the repo becomes public at v1, then Free is enough (public repos get rulesets and CodeQL for free).
3. Give Claude Code's GitHub identity access to the organization.

## 2. Repository [claude]

```bash
gh repo create "$OWNER/$REPO" --private \
  --description "Self-hosted PaaS: your own cloud on your own servers" \
  --disable-wiki

gh api -X PATCH "repos/$OWNER/$REPO" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F has_projects=false

# Dependency alerts (Renovate opens the fix PRs, so Dependabot security updates stay off to avoid duplicates)
gh api -X PUT "repos/$OWNER/$REPO/vulnerability-alerts"

# Default workflow token: read-only
gh api -X PUT "repos/$OWNER/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

Then push this documentation package as the first commit on `main` (the only direct push allowed):

```bash
git init -b main
git add .
git commit -m "docs: initial product, architecture, spec, plan and repository setup"
git remote add origin "git@github.com:$OWNER/$REPO.git"
git push -u origin main
```

## 3. Labels [claude]

```bash
for l in \
  "task:0E8A16" "bug:D73A4A" "security:B60205" "security-review:B60205" \
  "track:agent:1D76DB" "track:control-plane:5319E7" "track:web:FBCA04" "track:cross-cutting:C5DEF5" \
  "blocked:000000" "needs-decision:E99695"; do
  name="${l%:*}"; color="${l##*:}"
  gh label create "$name" --repo "$OWNER/$REPO" --color "$color" --force
done
```

## 4. Milestones and issues [claude]

```bash
for m in "M0 Foundations" "M1 Agent core" "M2 Control plane core" "M3 Deploy pipeline" \
         "M4 Networking and multi-node" "M5 Data" "M6 Observability" "M7 Previews" \
         "M8 Access and tooling" "M9 Migration" "M10 Hardening and beta"; do
  gh api "repos/$OWNER/$REPO/milestones" -f title="$m" -f state=open
done
```

At the start of each milestone, create one issue per task from `docs/PLAN.md` with the "Plan task" template, the milestone, the `task` label and the track label. Link dependencies in the issue body.

## 5. Branch protection on `main` [claude, needs GitHub Team while private]

Apply this section **only after task M0.2 is merged**. Before that, the required checks do not exist yet and the bootstrap PRs (M0.1, M0.2) could never merge.

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
          { "context": "TypeScript (lint, test, build)" },
          { "context": "Go (lint, test)" },
          { "context": "Generated code is up to date" },
          { "context": "Integration tests (Postgres, Docker)" },
          { "context": "Semgrep (custom rules + OWASP)" },
          { "context": "gosec" },
          { "context": "Secret scanning" },
          { "context": "Trivy filesystem scan" },
          { "context": "actionlint" }
        ] } }
  ]
}
JSON
```

Why zero required approvals: Claude Code opens PRs with the maintainer's identity, and GitHub does not let an author approve their own PR. The maintainer reviews and merges. When a second maintainer joins, raise the count to 1 and enable code owner review.

When the repository becomes public: set the repository variable `ENABLE_CODEQL` to `true` (`gh variable set ENABLE_CODEQL --body true --repo "$OWNER/$REPO"`) and add the two `CodeQL` checks to the required list.

## 6. Apps [human]

- Install the **Renovate** GitHub App on the repository (uses `renovate.json`).
- Enable **private vulnerability reporting** when the repository becomes public.

## 7. Secrets [human]

Set values yourself; never paste them into a chat or a commit.

| Secret               | Needed from | Purpose                                                                                               | Command                                                                  |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `HCLOUD_TOKEN`       | M10.1       | Create and delete VMs for nightly E2E tests (Hetzner Cloud project dedicated to CI)                   | `gh secret set HCLOUD_TOKEN --repo "$OWNER/$REPO"` (paste when prompted) |
| `HOMEBREW_TAP_TOKEN` | M8.2        | Push the CLI formula to `$OWNER/homebrew-tap` (fine-grained token, contents write on that repo only)  | `gh secret set HOMEBREW_TAP_TOKEN --repo "$OWNER/$REPO"`                 |
| `SCOOP_BUCKET_TOKEN` | M8.2        | Push the CLI manifest to `$OWNER/scoop-bucket` (fine-grained token, contents write on that repo only) | `gh secret set SCOOP_BUCKET_TOKEN --repo "$OWNER/$REPO"`                 |

Signing uses cosign keyless (GitHub OIDC), so no signing key secret is needed. GHCR uses the workflow `GITHUB_TOKEN`.

## 8. Releases

- Tags `vMAJOR.MINOR.PATCH` trigger `release.yml`: agent and CLI binaries (GoReleaser), control plane image on `ghcr.io/$OWNER/shipkeep`, all signed with cosign, SBOM and provenance attached.
- Pre-releases use `-alpha.N`, `-beta.N`, `-rc.N`.
