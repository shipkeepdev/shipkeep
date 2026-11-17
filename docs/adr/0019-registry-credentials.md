# ADR 0019: Registry credentials per organization

- Status: Accepted
- Date: 2026-11-17

## Context

Only public images can be deployed. The control plane resolves tags to digests anonymously, and it never fills the `registry_credentials` field that `PullImage` has had since ADR 0012, although the agent already validates it (same registry as the image, an expiry in the future). Most real applications ship from a private registry.

Three things had to be decided: where the credentials live, how an application refers to them, and who may manage them.

## Decision

- **An organization stores credentials per registry host.** One user name and one password or access token per host and optional port, as image references name it (`ghcr.io`, `registry.example.com:5000`). Docker Hub has one name, `docker.io`, however it is written.
- **An application does not refer to them.** A deployment of that organization whose image comes from that host uses them, for the digest lookup and for the pull. Nothing about credentials enters `shipkeep.yml` (rule 8), and an existing configuration needs no change.
- **Organization administrators manage them** (`organization.update`): `GET` and `POST …/organizations/{organizationId}/registries`, and `POST …/registries/{registryId}/remove`. Setting the same host again replaces the credentials.
- **They are write-only and encrypted.** The password goes through `EnvelopeService.encryptFor` with the organization's data key, bound to the host and the version, so a row moved to another host or organization does not decrypt. No route returns it. The audit log records the host, the user name and the version.
- **The address policy does not change.** A registry must still be a public HTTPS host. Registries on private networks stay an open question (SPEC 16).

## Using them

- **The digest lookup.** The control plane asks the registry without credentials first. Only after a 401 does it send them, as HTTP Basic: to the token service the registry names in its `Bearer` challenge, or to the registry itself when it asks for `Basic`. The token service is the registry's choice, as for `docker login`, and it goes through the same guards as the registry (HTTPS, public address, no redirect).
- **The pull.** `PullImage` carries the same credentials with an expiry equal to the action's deadline. The payload is encrypted in the queue like every action.
- **Docker Hub.** A reference without a registry host (`nginx`, `acme/app`) is on Docker Hub. The agent used to read the first path component as the registry, so it refused `docker.io` credentials for `acme/app` and would have accepted credentials named `acme`. It now reads a reference the way the Docker daemon does: the first component is a host only when it holds a dot or a port, or is `localhost`. This narrows what the agent accepts; it adds no action and no field.
- **Older agents.** An agent released before this rule (up to `0.1.0-alpha.2`) refuses `docker.io` credentials for such a reference with `invalid action input`. Once an organization stores Docker Hub credentials, every Docker Hub pull on a server with that agent fails, public images included, until the agent is updated. Registries named by a host work with older agents. Both were checked with the published `0.1.0-alpha.2` agent.

## Alternatives considered

- **Environment secrets named in `shipkeep.yml`.** Finer grained, but every application of every environment must name them, and the file gains a field that exists only to find a secret.
- **`docker login` on each server.** The agent never executes on the host (rule 3), and the credentials would stay on the server's disk for every container to use.
- **Credentials per project.** Useful when projects must not share a registry account. It can be added later as a narrower scope that wins over the organization's.

## Consequences

- Whoever may deploy in the organization can deploy any image the stored credentials can read. That is a deliberate trust boundary: the organization. Give the registry account read access to what the organization may run, nothing more.
- The password is decrypted when a deployment needs it. It then goes to the registry, to the token service that registry names, and to the server that pulls, inside the encrypted action payload and with an expiry.
- Removing credentials breaks the next pull of a private image from that host; running containers are not affected.
