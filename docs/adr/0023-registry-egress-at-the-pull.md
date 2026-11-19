# ADR 0023: The registry address policy at the node's pull

- Status: Accepted
- Date: 2026-11-19

## Context

The control plane refuses a registry whose host is, or resolves to, an address that is not public (SPEC 8, "SSRF guards"). It checks the answers it gets, then sends the node an image reference that still names the host. The node's Docker daemon pulls that reference: it resolves the name again, follows the registry's redirects and fetches tokens from the service the registry names, with none of the control plane's checks (#351, security audit of 19 November 2026).

A lab on a real node (Docker Engine 29.10.0, containerd image store, Ubuntu 24.04) measured what the daemon does. A small HTTPS registry served a valid certificate for its name, as an attacker can get for a domain they own. Plain HTTP servers on `127.0.0.1` and on the node's private address logged what reached them. Each pull went through `POST /images/create`, the call the agent's `PullImage` makes.

1. **The name is resolved again on the node.** With the node's answer for the registry name set to a private address, the daemon pulled the image from that address. A name that passed the control plane's check can answer differently a minute later (DNS rebinding).
2. **Redirects are followed anywhere, in plain HTTP.** A blob `GET` answered with `307 Location: http://127.0.0.1:8099/…` or `http://192.168.208.3:8098/…`: the daemon sent the `GET` there.
3. **The token service is called anywhere, in plain HTTP.** A `401` with `Bearer realm="http://127.0.0.1:8099/…"`: containerd sent `GET /…?scope=repository:…:pull&service=…` there.
4. **A name that resolves to loopback, on any port.** Docker treats `127.0.0.0/8` as an insecure registry by default. Version 29 does not fall back to HTTP, but it opened the TCP connection and sent its TLS handshake to the loopback port.

These are blind requests: the answer does not reach the user, the pull fails on the digest or the token, and the agent turns the daemon's text into a closed list of causes. The path, the query string and the port are the attacker's choice, though, and a closed port (`registry_unreachable`) gives a different cause from an open one. That is enough to probe the node's network and to send a `GET` with side effects to an internal service: a cloud metadata endpoint, an admin interface, a database's HTTP port. TLS limits only the first case, and only for services that answer TLS with a certificate for the attacker's name. Redirects and token services in plain HTTP have no such limit.

An application's container can also reach the network. The daemon is different: it runs on the host's network, as root, and the node's firewall rules for containers do not apply to it.

The same lab measured one way to constrain the daemon. Docker reads `HTTP_PROXY` and `HTTPS_PROXY` for its registry traffic. With them set to a logging proxy, every connection of cases 1 to 3 went through the proxy, which could refuse it, except one kind: Go never sends a request for `localhost`, `127.0.0.0/8` or `::1` to a proxy. A redirect or a token service on `http://127.0.0.1:…` still reached the loopback service directly.

The lab then tried an nftables rule that rejects new connections from the daemon's cgroup to loopback. The redirect and the token service on loopback were refused (`connection refused`) and nothing reached the probe. Other processes kept reaching loopback, and a pull from Docker Hub worked. Loaded by an `ExecStartPre` of the Docker unit, the rule kept refusing them after two restarts of Docker, each with a new cgroup.

## Decision

The maintainer chose an egress proxy on each node, with a firewall rule for loopback.

- **An egress proxy for the Docker daemon.** A new mode of the agent binary, `shipkeep-agent egress`, runs as its own systemd service, `shipkeep-egress`, under its own user. It listens on `127.0.0.1:7480` only. The installer points the daemon at it with a drop-in, `/etc/systemd/system/docker.service.d/shipkeep-egress.conf`, which sets `HTTP_PROXY`, `HTTPS_PROXY` and an empty `NO_PROXY`.
  - Docker applies the proxy settings of `daemon.json` before those of its environment. The installer does not edit `daemon.json`: it refuses to continue when that file sets any proxy field, and says which one to remove. After it restarts the daemon, it reads the settings the daemon reports (`docker info`) and refuses to finish unless they are exactly the proxy's address and an empty `NO_PROXY`.
  - The settings can change after the installation: someone edits `daemon.json`, or another drop-in sets the variables. So the agent reads them too (`GET /info`) before each pull. When they are not exactly the proxy's, it refuses the pull with a new cause, `egress_unguarded`, and the deployment says the server's Docker does not go through its egress proxy. An agent started with `--dev` skips this check and logs a warning.
  - The proxy accepts `CONNECT` only, so registry traffic stays HTTPS end to end and the proxy never sees it. A plain HTTP request, and so any redirect or token service in plain HTTP, is refused.
  - It resolves the name itself and connects only to an address that is public, by the same list as the control plane (not loopback, private, link-local, CGNAT, multicast, reserved or documentation ranges, including their IPv4-mapped and NAT64 forms). The check runs on the address the socket connects to, in the dialer, so a second answer cannot change it.
  - It bounds what it holds: 64 tunnels at once, 10 seconds to connect, one hour per tunnel (a pull of a large layer), and it logs the host, the port and the outcome of each tunnel, never a path or a header.
  - The proxy has no exception list now. A registry on a private network stays unsupported, as SPEC 16 says. When it is supported, its exception is an explicit setting of the server, reviewed like any other change of this policy.
- **A loopback guard in the kernel.** An nftables table, `inet shipkeep_egress`, has one chain in the `output` hook. It rejects the new connections that the processes of `docker.service` open to `127.0.0.0/8` or `::1`, with two exceptions, each an exact address and port:
  - the proxy, `127.0.0.1` port 7480, TCP;
  - each loopback name server listed in `/etc/resolv.conf` when the installer runs (`127.0.0.53` with systemd-resolved), port 53, UDP and TCP.

  Nothing else on loopback is allowed, so a service on `[::1]:7480` or on another port of the resolver's address is out of reach.
  - The rule matches the cgroup of `docker.service` (`socket cgroupv2`, level 2, `system.slice/docker.service`). It therefore touches neither the containers, which have their own network namespace, nor the other services of the host. The installer checks that systemd reports that cgroup for the unit, and refuses to continue otherwise.
  - nftables resolves that path to a numeric cgroup ID when the rule is loaded, and systemd creates a new cgroup, with a new ID, each time the service starts. The table is therefore loaded by the same drop-in, as `ExecStartPre=/usr/sbin/nft -f /etc/shipkeep/egress-guard.nft`. That command runs inside the new cgroup, after systemd created it and before `dockerd` starts, at boot and at every restart. The file replaces the whole table, so a reload never leaves a stale rule. If it fails, Docker does not start: the daemon never starts without the guard, at the cost of its availability. The installer checks the file with `nft -c` before it installs it.
  - `nftables.service` starts by flushing the whole ruleset with Ubuntu's default configuration, so a restart of it would remove the table while Docker runs. A second drop-in, for `nftables.service`, therefore loads the same file after it starts (`ExecStartPost=`). nftables resolves the cgroup path from any process, as long as Docker's cgroup exists. When Docker is not running, that load fails, and is ignored: Docker's own `ExecStartPre` loads the table before `dockerd` starts.
  - The guard is thus in place whenever `dockerd` runs, through restarts of Docker and of `nftables.service`. Only a person with root on the server removes it while Docker runs, by deleting the table or flushing the ruleset by hand. That person can also stop the proxy or edit the drop-ins: they are outside the threat model of this decision, which is a user who can deploy an image. The installation guide says not to flush the ruleset by hand, and that `systemctl restart docker` restores the guard.
  - It matches new connections only (`ct state new`). The replies of `docker-proxy`, which serves published ports from the daemon's cgroup, still reach local clients, such as the agent of a single-machine installation that connects to the gateway on loopback.
  - It catches what bypasses the proxy: the loopback literals of a redirect or a token service, and a name that resolves to loopback.

- **The agent contract keeps its actions.** `PullImage` stays the same action, with one more cause in its closed list (`egress_unguarded`). The control plane keeps its own checks: a reference refused there never reaches a node. The node's checks hold even if the control plane's answer was wrong or has changed.
- **Fail closed.** If the proxy is down, pulls fail with `registry_unreachable`. Running containers and routes are not affected. The service restarts after 5 seconds, like the agent.

## Alternatives considered

- **The agent pulls the image itself.** An OCI client in the agent, with a dialer that checks every address, then an import into Docker. It controls every connection, the loopback ones included. But it means a new dependency, an import that must keep the image's digest so that `CreateContainer` finds it, and a second implementation of what the daemon already does well. It remains possible if the daemon's behavior changes.
- **The proxy alone, with the loopback case documented.** Simpler, with no firewall rule. But the loopback case is the one the lab showed working, and on a single-machine installation the control plane's services are on that machine.
- **A firewall rule for every non-public address.** Docker's own processes (`docker-proxy`, which serves published ports) connect to container addresses, which are private. Such a rule would break published ports, so it is limited to loopback, and the proxy handles the rest.
- **Documenting the risk only.** It leaves a probe of each node's network to anyone who can deploy an image.

## Consequences

- A pull reaches only public addresses, over HTTPS, whatever the registry, its redirects or its token service answer. The public registries in use redirect blobs over HTTPS to public storage (Docker Hub, GHCR, ECR, GCR), so they keep working. A registry that redirects to plain HTTP stops working.
- The proxy sees host names and ports, so the node's log shows which registries it reaches. It never sees paths, tokens or credentials: they travel inside TLS.
- Every pull of the Docker daemon on the server goes through the proxy, including the images of the control plane on a single machine (`docker compose pull` at an upgrade). The agent checks the daemon's proxy settings before its own pulls only. Other pulls, such as `docker compose pull`, rely on the settings the installer checked and on the guard. An operator who uses the same daemon for something else gets the same policy for it, and the installation guide says so.
- The control plane installer pulls its images before the server installer runs, so a first installation is not affected. Later upgrades go through the proxy.
- Applying the drop-in needs a restart of the Docker daemon. On a new server the installer does it before any application runs. On a server already installed, the next run of the installer does it, and says that running containers restart with the daemon. Live restore is not assumed.
- nftables is part of Ubuntu 24.04. The installer checks that the `socket cgroupv2` match is available and refuses to continue without it, rather than install a proxy that loopback literals can bypass.
- New code: the egress mode of the agent, with tests for the address check at the dialer (rebinding, IPv4-mapped and NAT64 forms, IPv6 literals), the refusal of plain HTTP, the bounds and the log. The agent's check of the daemon's proxy settings before a pull, with the `egress_unguarded` cause. The installer's drop-in, guard file and checks, with tests of the installer (`install_test.sh`). A lab test on a real daemon that repeats the four cases above, also after a restart of Docker, and checks that nothing reaches the loopback or private probes.
- `docs/SPEC.md` (sections 8 and 16), `docs/THREAT_MODEL.md` and `docs/INSTALL.md` change with the implementation.
