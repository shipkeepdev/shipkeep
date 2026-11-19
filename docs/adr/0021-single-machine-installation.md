# ADR 0021: The control plane and applications on one machine

- Status: Accepted
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
  - installs the agent and its Caddy as `deploy/install.sh` does, and enrolls the agent as any server, pinned by the CA fingerprint, over loopback (next point).

  The organization and the join token come from two new operator commands, `node main.js organization create` and `node main.js server join-token`. They follow ADR 0020: they run only on the server, no route reaches them, and they are audited with the system as actor. The token goes from one command to the agent's token file without being printed.

- **The agent connects over loopback and still verifies the public name.** The agent checks that the gateway certificate names the host it dials, as well as the pinned CA (`agent/internal/gateway/client.go`), and that certificate names only `AGENT_GATEWAY_SERVER_NAME`. So the dial address and the verified name are separated: `control_plane.address` stays `<public name>:7443`, and an optional `control_plane.connect` (`127.0.0.1:7443` or `[::1]:7443`, loopback addresses only, refused otherwise) says where the TCP connection goes. The TLS name, the hostname check, the chain check and the CA pin are unchanged. The gateway certificate does not gain `127.0.0.1`: that address designates a different machine for every client, so a certificate valid for it proves nothing.
- **The control plane's share of the machine is reserved.** The agent's configuration gets a reservation (by default 0.5 CPU and 1 GiB on a single machine, 0 elsewhere). The agent subtracts it from the capacity it reports and reports the reservation itself in its facts. Ports need no rule: the agent exposes an application's ports on Shipkeep networks only and never publishes one on the host, so no application can take 7443 or the control plane's loopback port.
- **A redeployment on that machine counts both releases.** During switch-then-drain (ADR 0005) the old and the new release run together. Placement normally counts only the new one (`nodeLoads`, `apps/api/src/modules/deployments/domain/placement.ts`), so that an application which fills its server can still be redeployed. On a node that reports a reservation, the replicas being replaced keep counting until the deployment ends: when both releases do not fit beside the reservation, the deployment is refused with a reason that says so, before anything starts. Other servers keep today's rule.
- **A hard limit backs the reservation.** On a single machine the installer creates a systemd slice, `shipkeep-workloads.slice`, with `MemoryMax` set to the machine's memory minus the reservation and a lower CPU weight than the control plane's containers. The agent creates every application container in it (`CgroupParent`, from its local configuration, not from the control plane). If the accounting is ever wrong, the kernel kills an application under memory pressure, never PostgreSQL or the API. The action list does not change.
- **A minimum size.** The installer refuses the single-machine form below 2 CPUs or 3 GiB of memory, and says why: below that the reservation leaves no room for an application. Two machines stay possible there.
- **Two machines stay supported.** Answering no keeps today's installation: the control plane with its own Caddy, servers added from the Servers page. The guide recommends a separate machine when the applications are not trusted as much as the control plane.

## Alternatives considered

- **The control plane's Caddy also serves the applications.** The agent would configure a Caddy it does not own, inside a container of the control plane stack, and every server would differ depending on whether it hosts the control plane.
- **The installer writes the control plane's route into Caddy once.** Caddy keeps it with `--resume`, but nothing puts it back if the saved configuration is lost or reset. The route would also be built by a shell script instead of by the agent's typed Caddy client.
- **The control plane on other ports (8443 for the UI).** The UI then lives on an unusual port with its own certificate path, and many networks block it.
- **The control plane on the host network**, so that `TRUST_PROXY: loopback` keeps working. PostgreSQL would then have to listen on the host's loopback, where every process on the machine can reach it.
- **`127.0.0.1` in the gateway certificate**, so that the agent can dial it by address. See above: a certificate valid for loopback is valid for whatever answers on any client's loopback.
- **Skipping the agent's hostname check for loopback.** It weakens the one check that tells the agent it reached its own installation, for a case a separate dial address covers without it.
- **Keep counting only the new release everywhere**, and rely on the reservation. Two releases of an application limited to 2.5 GiB need 5 GiB for a moment: on a 4 GiB machine with 1 GiB reserved, each fits its limit and together they take the memory of PostgreSQL and the API.
- **Add the local server from the Servers page after installation**, as with any server. It works, but the operator runs a second installer on the same machine and pastes a token by hand, which a single installation is meant to avoid.

## Consequences

- One rented server is enough to install Shipkeep and deploy to it.
- The control plane and the applications share a kernel. An application that escapes its container reaches the key-encryption key and the database. The threat model and the guide say so, and recommend separate machines for untrusted code. Git builds (ADR 0012) will run on that machine too.
- An application that saturates the machine's CPU slows the control plane; the slice's CPU weight limits how much. Memory is capped by the slice.
- On the machine that hosts the control plane, an application that fills the room left beside the reservation cannot be redeployed with switch-then-drain: the deployment is refused and says why. Lowering its limits, or moving it to another server, makes room.
- The agent keeps serving the control plane's route during a control plane outage, like any route (architecture rule 10).
- New code: the agent's local route, `connect` address, reservation and slice (configuration and tests), the domain rule in the control plane and the agent, the placement rule for nodes with a reservation, the two operator commands, a Compose profile without Caddy and with the fixed subnet, and the installer's single-machine path. Uninstalling and upgrading the single-machine form must keep the agent's route in place.
- `docs/INSTALL.md`, `docs/THREAT_MODEL.md` and `docs/ARCHITECTURE.md` change with the implementation.

## Acceptance criteria

The implementation is done when, besides the unit tests of each part:

- **No forged client address.** From an application container on the same machine, a request with a forged `X-Forwarded-For` reaches the control plane only through Caddy, and the control plane records the real client address. A direct connection from that container to the control plane's port fails.
- **The control plane's route survives.** After a restart of Caddy, a restart of the machine, and the loss of Caddy's saved configuration, the route is back without manual action, and no `UpsertRoute` or `RemoveRoute` can change it, including one for the control plane's name.
- **Loopback enrollment keeps the checks.** The agent enrolls through `connect: 127.0.0.1:7443`. It refuses a gateway certificate for another name, a CA with another fingerprint, and a `connect` address that is not loopback.
- **Capacity.** A redeployment whose two releases do not fit beside the reservation is refused before anything starts. An application that goes over the slice's memory is killed, and PostgreSQL and the API keep answering. The installer refuses a machine with 1 CPU or less than 3 GiB.
- **A real machine.** An installation in the single-machine form on a real virtual machine with a public name and certificate, then a redeployment while an application loads the machine, with the control plane answering throughout.
