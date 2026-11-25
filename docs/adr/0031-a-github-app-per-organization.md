# ADR 0031: A GitHub App per organization, made with GitHub's manifest flow

- Status: Accepted
- Date: 2026-11-24

## Context

M3.1 lists four providers: GitHub, GitLab, Gitea and Bitbucket. The first stable version deploys from Git through a GitHub App only (PLAN, step 3).

Shipkeep is self-hosted, and GitHub delivers webhooks to one URL per App, signed with one secret. A central App owned by the project would need a relay to reach every installation, which is a new external service, and it would hold every installation's webhook secret.

GitHub's manifest flow lets anyone create an App from a description the control plane sends. GitHub then hands the control plane the App's identifier, private key, webhook secret and client credentials.

## Decision

### Who owns the App

Each Shipkeep organization creates its own App through the manifest flow.

- An owner starts the flow from the organization's settings. The App is created on the GitHub account or organization the owner chooses there.
- It is private (`public: false`), so only that account can install it.
- Its name is `Shipkeep <organization slug> <6 random characters>`, since GitHub names are global. GitHub allows 34 characters, so the slug is cut to fit.
- Its webhook URL is `https://<control plane name>/api/v1/webhooks/github/<organization id>`.
- **Permissions** are asked once, since changing them later needs every installation to accept again:
  - metadata: read;
  - contents: write, to read `shipkeep.yml` and write it back (#214);
  - pull requests: write;
  - commit statuses: write, to show a deployment on its commit.
- **Events:** `push`. Installation events are always sent.
- **Storage.** The private key, the webhook secret and the client secret are encrypted with `EnvelopeService` for the organization. They never reach a response, a log or `shipkeep.yml`. Replacing the App is a typed confirmation of the owner, and it deletes the old credentials.

A per-organization App needs no installation-wide administrator, a role Shipkeep does not have yet (SPEC, "Open questions"). An organization's repositories reach only that organization.

### Repositories

The owner installs the App on the repositories they choose. GitHub returns to the control plane with the installation's identifier, which the control plane checks as the App, with its JWT (`GET /app/installations/{id}`). An application then names a repository of that installation, a branch and a configuration path (SPEC 4).

Each GitHub call uses an installation token, minted when it is needed, for the one repository and the permissions that call needs, and kept in memory only. It lasts at most an hour, as GitHub sets. A build receives one inside its encrypted action, with read access to its repository's contents only, and the control plane revokes it when the build ends (ADR 0030).

### Webhooks

- **Signature.** The control plane checks `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body with the App's webhook secret, in constant time, before it parses anything. A body over 1 MiB is refused unread.
- **Replay.** GitHub signs the body without a timestamp, so THREAT_MODEL T3's five-minute window cannot apply, and a signed body stays valid forever. Two checks replace it:
  - each `X-GitHub-Delivery` identifier is recorded, unique, for 30 days, and a delivery recorded before answers `200` and does nothing;
  - before queuing, the control plane asks GitHub for the branch's head, and deploys the pushed commit only while it is still that head. A replayed old push, even past 30 days, therefore deploys nothing.
- **Redelivery.** GitHub redelivers with the same identifier. The identifier is recorded in the same transaction that queues the deployment, so a delivery that failed before that point is recorded nowhere, and its redelivery is processed.
- **Deployment.** A verified `push` to an application's branch queues that commit's deployment, as the actor `system` with the pusher's GitHub login in the payload. In a protected environment (SPEC 7), a push deploys nothing by itself: the commit waits for an administrator to deploy it.

### `shipkeep.yml`

The file in the repository is the source of truth, as PRODUCT and CLAUDE.md property 2 say. An edit in the interface becomes a pull request, which is the default, or a commit, depending on the project's `git_write_mode`. When GitHub refuses a commit to a protected branch, the change becomes a pull request instead, the more reversible outcome.

### Later

GitLab, Gitea, Bitbucket and personal access tokens are left for after v0.1.0. GitHub sign-in (#250) stays separate: this App is not used to sign anyone in.

## Consequences

- No new external service: GitHub calls the installation directly, so the control plane's name must be public, as it is for HTTPS already.
- Each organization creates its App once, in about a minute, from the interface.
- A replayed webhook can only ask again for the commit its branch already points to, within the organization's own App.
- THREAT_MODEL T3 changes for GitHub: deduplication of delivery identifiers and the branch head check replace the timestamp window.

## Alternatives considered

- **One App owned by the project, with a relay.** It is a new external service, and it holds every installation's secrets.
- **One App per installation.** It needs an installation-wide administrator. On an installation with several organizations, the App's owner could read every organization's repositories.
- **Personal access tokens first.** They are long-lived, broader than one repository, and tied to a person rather than to the organization.
