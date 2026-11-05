# ADR 0015: Tenant isolation of fleet records

- Status: Accepted
- Date: 2026-11-05

## Context

SPEC 4 requires every tenant-scoped table to carry `organization_id`, filtered in repositories and enforced by PostgreSQL row-level security. The fleet tables fell short in two ways:

- `nodes` and `join_tokens` carry the organization, but no RLS policy enforces it.
- `node_certificates` carries no organization at all and inherits it only through `node_id`.

Two fleet operations start without a tenant context:

- **Enrollment.** The agent presents only a join token, so its organization is unknown until the token is found.
- **Gateway authentication.** Each RPC checks a client certificate. The certificate is signed by the installation CA, and its SPIFFE ID already names the organization and the node.

The earlier plan (PLAN M2.3g) proposed a separate database role for these lookups.

## Decision

1. **Certificates carry their organization (M2.3g1a).**
   - `node_certificates.organization_id` is NOT NULL and part of the composite foreign key `(organization_id, node_id) -> nodes(organization_id, id)`. A certificate can never point to another tenant's node.
   - The migration backfills the column from `nodes`.
2. **Forced RLS on `nodes`, `join_tokens` and `node_certificates` (M2.3g1b).** Each table gets the same `tenant_scope` policy as the other tenant tables (`organization_id = app.org_id`). The runtime role check counts these tables too.
3. **Gateway lookups are tenant-scoped.** The organization comes from the TLS-verified certificate's SPIFFE ID, never from the request, and certificate checks and renewals run under `runTenant`. A forged organization in the certificate is impossible without the CA key, and a wrong one finds no row.
4. **Enrollment lookup uses a context-bound, SELECT-only policy instead of a separate role.**
   - `runEnrollment(tokenHash)` sets a transaction-local `app.join_token_hash` and clears the tenant and account contexts.
   - A `join_token_lookup` policy then exposes only the `join_tokens` row with that exact hash.
   - Everything after the lookup runs under `runTenant` for the token's organization: node, certificate, token consumption and audit.
   - This is the pattern already used by account discovery (`app.user_id`). It needs no second login, grant set or provisioning step.

## Consequences

- A bug in a fleet repository can no longer read or write another tenant's nodes, certificates or tokens. PostgreSQL returns nothing outside the active organization.
- A caller that knows a token hash can read that one row. The hash is a SHA-256 of a 256-bit secret, and the API computes it only from a presented token.
- Fleet integration tests must use the restricted runtime login. They read rows through the administrative connection, as the other tenant tests do.
- Audit rows stay outside RLS until M2.3g2.
