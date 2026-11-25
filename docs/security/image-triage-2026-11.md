# Image triage, November 2026

The high and critical advisories found by the 2026-11-25 audit (#480) in the published control
plane image v0.1.0-alpha.3 and in the third-party images Shipkeep pins, and what was done with
each. Counts and findings come from Trivy 0.70 with that day's database. The rescans are the
security workflow's runs on #497, for linux/amd64 and linux/arm64.

A published image never changes. The release v0.1.0-alpha.3 keeps what it was built with; v0.1.0-alpha.4
replaces it.

| Advisory                                         | Component, image                                    | Disposition                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CVE-2026-121707 (high)                           | `effect` 3.20.0, control plane alpha.3              | Affected. Fixed in the source: the lockfile has `effect` 3.22.4 (fix in 3.22.1). The image built from main passes the scan with no exception. Replaced by alpha.4.                                                 |
| CVE-2023-45853 (critical)                        | zlib, control plane alpha.3 (Debian Bookworm)       | Not affected, per the vendor: the flaw is in minizip, which Debian's zlib packages do not build ([Debian tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853)). Not reported on the rebuilt image. |
| Other alpha.3 findings                           | control plane alpha.3                               | The image rebuilt from main, on the refreshed `node:22-bookworm-slim` and `golang:1.26-bookworm` digests, passes the scan with no exception. Replaced by alpha.4.                                                  |
| CVE-2026-6653 (high)                             | libxml2, `postgres:17`                              | Fixed upstream: not reported on the rebuilt digest `sha256:87c8b42f…`.                                                                                                                                             |
| CVE-2026-124851 (high)                           | libzstd1, `postgres:17`                             | Accepted until 2026-12-18 in `.trivyignore.yaml`. Fixed in Debian 13, not yet in the official image. PostgreSQL listens only on the private Compose network.                                                       |
| CVE-2025-68121 and the other Go findings in gosu | `postgres:17`, `usr/local/bin/gosu`                 | Accepted until 2026-12-18, path by path. gosu switches user once at start, and uses no TLS.                                                                                                                        |
| CVE-2026-85091                                   | zlib1g, `postgres:17`                               | Accepted until 2026-12-18 (existing entry).                                                                                                                                                                        |
| CVE-2026-78661 (high)                            | `golang.org/x/net` 0.60.0, `caddy:2.11.9-alpine`    | Accepted until 2026-12-18 (existing entry). Fixed in x/net 0.62.0, in no Caddy release or image yet.                                                                                                               |
| CVE-2026-78661 (high)                            | `golang.org/x/net` 0.60.0, VictoriaMetrics v1.155.0 | Fixed: v1.157.0 passes the scan.                                                                                                                                                                                   |
| none                                             | VictoriaLogs v1.54.0                                | Nothing found.                                                                                                                                                                                                     |

Each acceptance expires: the scan fails again on that date, and the entry is reviewed then. The
Shipkeep image itself accepts nothing.
