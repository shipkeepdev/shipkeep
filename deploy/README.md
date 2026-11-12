# Node installer acceptance (M8.3a)

Build with `pnpm nx build web` and deploy its complete `dist/apps/web/browser` directory alongside the API on the configured HTTPS origin. Go is required at build time; installer artifacts are public and must not be edited after building. Independent release signing is tracked by M8.2.

Use a disposable Ubuntu 24.04 amd64/arm64 VM with systemd, sudo, iproute2, outbound HTTPS and gateway access, and free ports 80/443. No SSH credentials are needed by the control plane.

1. In Servers, create a join token, execute the displayed checksum-verified command on the VM, then paste the token into its hidden stdin prompt. Never put the token in argv or shell history.
2. Refresh Servers until the node is `ready`. Check `systemctl is-active shipkeep-agent shipkeep-caddy docker`; on failure inspect `journalctl -u shipkeep-agent` without printing the token file.
3. Check `/etc/shipkeep` is owned by `shipkeep:shipkeep` with mode 0700, `agent.yaml` is 0600, and successful enrollment has removed `join-token` (0600 while pending).
4. Check the admin socket is `shipkeep-caddy:shipkeep` mode 0660, with no TCP admin listener. Through the agent, deploy a route, then update it a second time: every update reloads Caddy, and the socket must stay at 0660. Restart `shipkeep-caddy`, then `kill -9` it, and verify after each that it comes back and the route still serves. Reboot and repeat.
5. Running the command again must refuse the existing installation. Record OS, architecture, commit, service status and routing results without credentials.

A failed run is not cleaned up automatically, and reruns then refuse with "Existing Shipkeep installation". To start over on a disposable VM, stop and disable `shipkeep-agent` and `shipkeep-caddy`, then remove their unit files, `/etc/shipkeep`, `/var/lib/shipkeep`, `/var/lib/shipkeep-caddy`, `/run/shipkeep`, `/etc/shipkeep-caddy.json`, `/etc/tmpfiles.d/shipkeep.conf`, the `shipkeep` and `shipkeep-caddy` accounts, then the `shipkeep` group (it is the primary group of `shipkeep-caddy`, so removing the accounts leaves it), and the `caddy` package with its `shipkeep-caddy` apt source and key.

To enroll a development agent, issue a join token in Servers (the page shows the manual setup without HTTPS), save it as a 0600 file, set `control_plane.join_token_file` and run `go run ./agent/cmd/shipkeep-agent --dev`.

Local checks: `shellcheck deploy/*.sh` and `bash deploy/install_test.sh`, plus the repository checks in `CLAUDE.md`. Container checks cannot replace the real VM enrollment/reboot acceptance; M8.3a remains unchecked until that evidence exists.
