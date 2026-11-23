# ADR 0025: A maintenance page served by Caddy

- Status: Accepted
- Date: 2026-11-23

## Context

The design's danger zone offers "Enter maintenance: Caddy serves a maintenance page; containers keep running" (#256). Stopping, starting and deleting an application are done. The maintenance page is not, because no typed action expresses it: `UpsertRoute` only proxies to upstreams, and the agent refuses a route without one.

Two ways were weighed:

- **A container that serves the page.** It needs no new input: `PullImage`, `CreateContainer` and `UpsertRoute` already exist. But every server would run one more container, which placement must reserve room for (ADR 0021). Caddy would also relay to that container instead of answering itself.
- **Caddy answers itself.** The route carries a flag, and the agent writes a `static_response` instead of a `reverse_proxy`. Nothing more runs on the server. It changes the input of an existing action.

The maintainer chose the second on 2026-11-23.

## Decision

**Agent contract.**

- `Route` gains `bool maintenance = 6`.
- A maintenance route has no upstream, and any other route has at least one. The agent refuses a route that breaks this, like any other invalid input.
- The page is built into the agent: fixed, neutral English text. No text of it comes from the control plane, so an action cannot use it to show anything else on an application's domains. Caddy serves it as a `static_response`:
  - status 503, `Retry-After: 120` and `Cache-Control: no-store`, so clients and search engines treat it as temporary;
  - `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`;
  - a Content-Security-Policy of `default-src 'none'` that allows only the page's one style, by its SHA-256 hash. The page holds no script, image, font, link or form.
- Everything else works as for any route:
  - the host checks, including the control plane's own name (ADR 0021);
  - the TLS mode;
  - switch-then-drain, so the requests the replicas were serving finish before the switch succeeds.

**Control plane** (the next pull requests of #256).

- Entering and leaving maintenance are deployments of the release that runs, like a stop (SPEC 5.1). They create no release, need no image or secret, and place and start nothing. They go from `queued` through `switching` to `succeeded`. In `switching`, each node that hosts a placed replica gets an `UpsertRoute`:
  - entering sends the application's hosts with `maintenance`;
  - leaving sends its replicas again.
- Each is audited like any deployment, and shown in the application's history and on the deployment page.
- An application is in maintenance when its last succeeded deployment entered it. While it is:
  - a deployment and a rollback are refused (409), so that a new release never starts behind the page unseen: leave maintenance first;
  - a stop is allowed, and ends the maintenance with the replicas.
- An agent released before this change (`0.1.0-alpha.1` to `0.1.0-alpha.3`) does not know the flag. Entering maintenance is refused when such an agent hosts a replica of the application, as Docker Hub credentials are for older agents (ADR 0019). Should one receive it anyway, it refuses the route, which has no upstream, and the route stays as it was.

## Consequences

- The agent action list is unchanged. One action gains one boolean input, validated by the agent, with tests that include malicious input. It grants no new reach: the flag replaces proxying with a fixed page, on hosts the route could already serve.
- Nothing more runs or is reserved on the servers, and the page keeps being served while the control plane is down (Caddy `--resume`).
- The page cannot be customized. A custom text or a custom page would need a new decision: the text would come from the control plane and reach visitors, and would need to be bounded and escaped.
