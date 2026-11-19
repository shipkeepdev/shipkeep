# ADR 0021: The control plane and applications on one machine

- Status: Proposed
- Date: 2026-11-19

## Context

Today an installation needs two machines: the control plane, and at least one server that runs applications. The control plane's Compose stack runs its own Caddy on ports 80 and 443, and the server installer (`deploy/install.sh`) refuses a machine where they are taken, because the server's Caddy needs them for the applications (ADR 0005). `docs/INSTALL.md` therefore says to use a separate machine.

Most people who try Shipkeep rent one server. Two machines double the cost and the setup before the first deployment, and the comparable tools install on one.

To be decided:

- which process owns ports 80 and 443 when both run on the machine;
- how the control plane's route is kept, so that nothing a deployment does can remove it;
- how the server on the same machine is added without a second installation;
- what the shared machine changes for security and for capacity.

## Decision

- **One Caddy per machine.** On a single machine, the Caddy of the server (`shipkeep-caddy`, installed and configured as on any server) owns ports 80 and 443. The control plane's Compose stack runs without its own Caddy, and its HTTP port is published on `127.0.0.1` only. The agent gateway (7443) stays published on all addresses, so that more servers can be added later.
- **The control plane's route belongs to the agent's local configuration, not to the control plane.** The installer writes the control plane's DNS name and its loopback address into the agent's configuration file. At start, before and independently of enrollment, the agent applies that route through the Caddy admin API, with a fixed id outside the `sk-route-` prefix. No action can change or remove it: `UpsertRoute` and `RemoveRoute` act only on `sk-route-` ids, and the agent refuses a route for that name. The action list does not change.
- **An application cannot take the control plane's name.** The control plane refuses a domain equal to the host of `API_PUBLIC_URL`, and the agent refuses it too (defense in depth, with malicious-input tests).
- **Forwarded headers are trusted from the machine only.** Caddy runs on the host and reaches the control plane through Docker's published loopback port, so the control plane sees the gateway address of its Compose network, not `127.0.0.1`. The Compose file fixes that network's subnet, and `TRUST_PROXY` names its gateway address only. The implementation tests which source address the control plane sees, with Docker's userland proxy on and off.
- **One installer run gives a server ready to deploy.** The control plane installer asks whether applications also run on this machine (default yes). If so, after creating the first account (ADR 0020), it:
  - asks the name of the first organization and creates it with that account as owner;
  - issues a join token for it;
  - installs the agent and its Caddy as `deploy/install.sh` does, and enrolls the agent against the control plane on `127.0.0.1:7443`, pinned by its CA fingerprint as on any server.

  The organization and the join token come from two new operator commands, `node main.js organization create` and `node main.js server join-token`. They follow ADR 0020: they run only on the server, no route reaches them, and they are audited with the system as actor. The token goes from one command to the agent's token file without being printed.

- **The control plane's share of the machine is reserved.** The agent's configuration gets a reservation (by default 1 CPU and 1 GiB on a single machine, 0 elsewhere) that it subtracts from the capacity it reports. Placement then never counts the memory PostgreSQL and the control plane need. Ports need no rule: the agent exposes an application's ports on Shipkeep networks only and never publishes one on the host, so no application can take 7443 or the control plane's loopback port.
- **Two machines stay supported.** Answering no keeps today's installation: the control plane with its own Caddy, servers added from the Servers page. The guide recommends a separate machine when the applications are not trusted as much as the control plane.

## Alternatives considered

- **The control plane's Caddy also serves the applications.** The agent would configure a Caddy it does not own, inside a container of the control plane stack, and every server would differ depending on whether it hosts the control plane.
- **The installer writes the control plane's route into Caddy once.** Caddy keeps it with `--resume`, but nothing puts it back if the saved configuration is lost or reset. The route would also be built by a shell script instead of by the agent's typed Caddy client.
- **The control plane on other ports (8443 for the UI).** The UI then lives on an unusual port with its own certificate path, and many networks block it.
- **The control plane on the host network**, so that `TRUST_PROXY: loopback` keeps working. PostgreSQL would then have to listen on the host's loopback, where every process on the machine can reach it.
- **Add the local server from the Servers page after installation**, as with any server. It works, but the operator runs a second installer on the same machine and pastes a token by hand, which a single installation is meant to avoid.

## Consequences

- One rented server is enough to install Shipkeep and deploy to it.
- The control plane and the applications share a kernel. An application that escapes its container reaches the key-encryption key and the database. The threat model and the guide say so, and recommend separate machines for untrusted code. Git builds (ADR 0012) will run on that machine too.
- An application that saturates the machine slows the control plane. The reservation limits what placement assigns, not what a container uses beyond its limits, so the default resource limits (1 CPU and 512 MiB) matter more here.
- The agent keeps serving the control plane's route during a control plane outage, like any route (architecture rule 10).
- New code: the agent's local route and reservation (configuration and tests), the domain rule in the control plane and the agent, the two operator commands, a Compose profile without Caddy and with the fixed subnet, and the installer's single-machine path. Uninstalling and upgrading the single-machine form must keep the agent's route in place.
- `docs/INSTALL.md`, `docs/THREAT_MODEL.md` and `docs/ARCHITECTURE.md` change with the implementation.
