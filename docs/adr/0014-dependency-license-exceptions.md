# ADR 0014: Dependency license exceptions

- Status: Accepted
- Date: 2026-11-05

## Context

CLAUDE.md allows MIT, Apache-2.0, BSD-2/3, ISC and MPL-2.0 and requires approval for anything else. ADR 0010 requires every dependency to be compatible with Apache-2.0 distribution. One production dependency is outside the list:

- `argparse` 3.x (PSF-2.0). It comes through `js-yaml` from `@nestjs/swagger`, which serves the OpenAPI document.

## Decision

- `argparse` under PSF-2.0 is approved as a transitive dependency of `js-yaml`.
- The approval covers this package only. PSF-2.0 is not added to the general allow-list.
- PSF-2.0 is a permissive, OSI-approved license, compatible with Apache-2.0 distribution. A distribution must keep the full PSF license agreement and its copyright notice, and a derivative work must also summarize its changes. `argparse` ships unchanged, and the control plane image carries its full license agreement in the package directory (`node_modules/.pnpm/argparse@<version>/node_modules/argparse/LICENSE`). `NOTICE` names it and points there, but is not enough on its own: whoever repackages `argparse` without that directory ships the LICENSE file with it, and the third-party license bundle (M8.3) must include the full text.
- Every new exception is added to this ADR with the package, the license, the path that pulls it in and the reason, and is approved by the maintainer.

## Approved exceptions

| Package                                                                                        | License                    | Pulled in by                                               | Scope                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `argparse`                                                                                     | PSF-2.0                    | `js-yaml` <- `@nestjs/swagger` (API)                       | transitive, runtime                         |
| `@fontsource-variable/outfit`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | OFL-1.1 (fonts), MIT (CSS) | web UI (`apps/web/src/styles.css`)                         | direct, bundled fonts — approved 2026-11-18 |
| Simple Icons path data (copied into `apps/web/src/app/shell/brands.ts`)                        | CC0-1.0                    | web UI brand marks                                         | vendored data, no package                   |
| `tslib`                                                                                        | 0BSD                       | `@angular/cdk` (web), `tsyringe` <- `@peculiar/x509` (API) | transitive, runtime — approved 2026-11-18   |
| `postgres`                                                                                     | Unlicense                  | `prisma` (API, migrations)                                 | transitive, runtime — approved 2026-11-18   |
| `robust-predicates`                                                                            | Unlicense                  | `@prisma/studio-core` <- `prisma`                          | transitive, runtime — approved 2026-11-18   |
| `elkjs`                                                                                        | EPL-2.0                    | `@prisma/studio-core` <- `prisma`                          | transitive, runtime — approved 2026-11-18   |

Why they are needed: the design uses Outfit, Geist and Geist Mono, and shows the brand marks of the integrations (GitHub, GitLab, Docker, PostgreSQL…). The web UI's Content-Security-Policy allows fonts and images from `'self'` only, so they are bundled instead of loaded from a CDN. OFL-1.1 allows bundling and redistribution with the application as long as the fonts are not sold alone and keep their license; CC0-1.0 is a public-domain dedication with no obligation. The marks themselves stay trademarks of their owners and only identify the matching integration.

Found by the license check (2026-11-18). 0BSD and Unlicense are permissive and ask for nothing, not even a notice. EPL-2.0 is a weak, file-level copyleft: distributing `elkjs` unchanged is allowed, provided recipients are told that its source is available under EPL-2.0 and where. The `NOTICE` file, which the control plane image ships at `/app/NOTICE`, names `elkjs`, its license and its source (GitHub and npm), and the package keeps its own license file in the image. It ships because `prisma` is a runtime dependency (the image runs `prisma migrate deploy`) and the Prisma CLI includes Prisma Studio. Removing that dependency means running migrations without the Prisma CLI.

## Enforcement

`tools/ci/licenses.json` holds the allowed licenses and these exceptions, and the `Licenses` job of the security workflow runs `tools/ci/check-licenses.mjs` on Trivy's license report of the production dependencies (npm and Go). Each package version is checked on its own. A dependency outside the list without an approved exception fails the job, and so does an exception still marked pending here: nothing reaches `main` before the maintainer approves it. A dependency version whose license Trivy finds nowhere fails too, unless that exact version is recorded under `undetected` with the license read by hand. The report must hold the inventories of `pnpm-lock.yaml` and of the three `go.mod` files. A test checks that every exception of that file appears in this ADR. Development dependencies are not checked: they are not distributed.

## Consequences

- The license audit stays strict by default. Exceptions are visible in one place and reviewed like any decision.
- If `js-yaml` drops `argparse`, or if `@nestjs/swagger` stops depending on `js-yaml`, remove the row.
