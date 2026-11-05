import type { NodeFacts as ProtoNodeFacts } from '@shipkeep/proto-ts';

/**
 * Proto `NodeFacts` as stored node facts: snake_case keys, as `sanitizeFacts` expects. Spreading
 * the message kept camelCase keys, which sanitizing dropped, losing CPU and memory capacity.
 */
export function factsFromProto(facts: ProtoNodeFacts | undefined): Record<string, unknown> {
  if (!facts) return {};
  return {
    hostname: facts.hostname,
    os: facts.os,
    os_version: facts.osVersion,
    kernel_version: facts.kernelVersion,
    architecture: facts.architecture,
    cpu_count: facts.cpuCount,
    memory_bytes: facts.memoryBytes,
    disk_bytes: facts.diskBytes,
    disk_free_bytes: facts.diskFreeBytes,
    docker_version: facts.dockerVersion,
    caddy_version: facts.caddyVersion,
    wireguard_version: facts.wireguardVersion,
    agent_version: facts.agentVersion,
  };
}
