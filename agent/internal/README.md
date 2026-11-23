# Internal packages of the agent. Populated from task M1.1.

- `upgrade`: what an agent checks before it replaces its own binary (ADR 0028): the release version, the archive address built from it, the archive's Sigstore signature verified offline, and the binary extracted alone.
