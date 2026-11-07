# ADR 0014: Dependency license exceptions

- Status: Accepted
- Date: 2026-11-05

## Context

CLAUDE.md allows MIT, Apache-2.0, BSD-2/3, ISC and MPL-2.0 and requires approval for anything else. ADR 0010 requires every dependency to be compatible with Apache-2.0 distribution. The post-merge audit of 2026-11-05 found one production dependency outside the list:

- `argparse` 3.x (PSF-2.0). It comes through `js-yaml` from `@nestjs/swagger`, which serves the OpenAPI document.

## Decision

- `argparse` under PSF-2.0 is approved as a transitive dependency of `js-yaml`.
- The approval covers this package only. PSF-2.0 is not added to the general allow-list.
- PSF-2.0 is a permissive, OSI-approved license. Its only obligation is to keep the copyright and license notice, so it is compatible with Apache-2.0 distribution. The release `NOTICE` and third-party license bundle (M8.3) must include it.
- Every new exception is added to this ADR with the package, the license, the path that pulls it in and the reason, and is approved by the maintainer.

## Approved exceptions

| Package                                                                                        | License                    | Pulled in by                         | Scope                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `argparse`                                                                                     | PSF-2.0                    | `js-yaml` <- `@nestjs/swagger` (API) | transitive, runtime                                         |
| `@fontsource-variable/outfit`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | OFL-1.1 (fonts), MIT (CSS) | web UI (`apps/web/src/styles.css`)   | direct, bundled fonts — **pending maintainer approval**     |
| Simple Icons path data (copied into `apps/web/src/app/shell/brands.ts`)                        | CC0-1.0                    | web UI brand marks                   | vendored data, no package — **pending maintainer approval** |

Why the fonts and brand marks: the owner's design uses Outfit, Geist and Geist Mono, and shows the brand marks of the integrations (GitHub, GitLab, Docker, PostgreSQL…). The web UI's Content-Security-Policy allows fonts and images from `'self'` only, so they are bundled instead of loaded from a CDN. OFL-1.1 allows bundling and redistribution with the application as long as the fonts are not sold alone and keep their license; CC0-1.0 is a public-domain dedication with no obligation. The marks themselves stay trademarks of their owners and only identify the matching integration.

## Consequences

- The license audit stays strict by default. Exceptions are visible in one place and reviewed like any decision.
- If `js-yaml` drops `argparse`, or if `@nestjs/swagger` stops depending on `js-yaml`, remove the row.
