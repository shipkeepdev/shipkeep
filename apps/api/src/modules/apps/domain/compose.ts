import { parse as parseYaml } from 'yaml';

/**
 * Validates a Compose file into typed services (SPEC 2.2, THREAT_MODEL "Compose injection").
 *
 * An allow-list that fails closed: a key is either translated faithfully to what the agent's typed
 * `ContainerSpec` can express, or refused with its reason. Nothing unsafe is ever passed through,
 * because nothing is passed through at all.
 */

export interface ComposeIssue {
  /** Where, for example `services.web.volumes[0]`. */
  readonly path: string;
  readonly message: string;
}

export type ComposeMount =
  | {
      readonly kind: 'volume';
      readonly volume: string;
      readonly target: string;
      readonly readOnly: boolean;
    }
  | { readonly kind: 'tmpfs'; readonly target: string };

export type ComposeHealth =
  | { readonly kind: 'http'; readonly path: string; readonly port: number | null }
  | { readonly kind: 'tcp'; readonly port: number };

export interface ComposeService {
  readonly name: string;
  /** May still be tag-pinned; the pipeline resolves it to a digest, as for image applications. */
  readonly image: string;
  /** Argv; empty keeps the image default. Never a shell string. */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Names used as `${NAME}` in `env`: they must be set as secrets, or the deployment is blocked. */
  readonly references: readonly string[];
  /** Container ports. Nothing is published on the host: `shipkeep.yml` `expose` routes traffic. */
  readonly ports: readonly number[];
  readonly mounts: readonly ComposeMount[];
  readonly dependsOn: readonly string[];
  readonly restart: 'always' | 'on-failure' | 'never';
  readonly health: ComposeHealth | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: string | null;
  readonly workingDir: string | null;
  readonly readOnlyRootfs: boolean;
  readonly capAdd: readonly string[];
  readonly stopTimeoutMs: number | null;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

export interface ComposeFile {
  readonly services: readonly ComposeService[];
  readonly volumes: readonly string[];
}

export type ComposeResult =
  | { readonly ok: true; readonly file: ComposeFile; readonly warnings: readonly ComposeIssue[] }
  | { readonly ok: false; readonly issues: readonly ComposeIssue[] };

export const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_SERVICES = 32;
const MAX_ISSUES = 50;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_STOP_MS = 600_000;

/** Same reasons a reviewer would give: these keys reach the host or the kernel. */
const DANGEROUS: Readonly<Record<string, string>> = {
  privileged: 'privileged containers can take over the server',
  pid: 'sharing a process namespace exposes other containers or the host',
  ipc: 'sharing an IPC namespace exposes other containers or the host',
  uts: 'sharing a UTS namespace exposes the host',
  userns_mode: 'changing the user namespace weakens isolation',
  network_mode: 'every service runs on the application network',
  devices: 'host devices cannot be mounted',
  device_cgroup_rules: 'host devices cannot be reached',
  cgroup: 'changing the cgroup namespace weakens isolation',
  cgroup_parent: 'changing the cgroup parent weakens isolation',
  sysctls: 'kernel settings cannot be changed',
  ulimits: 'resource limits come from the deployment plan',
  volumes_from: 'volumes are declared per service',
  extra_hosts: 'name resolution is managed by Shipkeep',
  dns: 'name resolution is managed by Shipkeep',
  dns_search: 'name resolution is managed by Shipkeep',
  dns_opt: 'name resolution is managed by Shipkeep',
  links: 'services reach each other by name on the application network',
  external_links: 'services reach each other by name on the application network',
  cap_drop: 'capabilities can only be added from the allow list for now',
  build: 'Compose applications use prebuilt images for now',
  entrypoint: 'the image entrypoint cannot be replaced; use `command`',
  env_file: 'files on the control plane cannot be read; use `environment` and secrets',
  secrets: 'set secrets in Shipkeep and reference them as `${NAME}` in `environment`',
  configs: 'Compose configs are not supported',
  extends: 'extending other files is not supported',
  profiles: 'Compose profiles are not supported',
  init: 'an init process cannot be added for now',
  pull_policy: 'images are always pulled by digest',
  runtime: 'the container runtime cannot be changed',
  isolation: 'the isolation mode cannot be changed',
  group_add: 'supplementary groups cannot be added',
};
const CAPABILITIES = new Set(['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID']);
const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev', '/etc', '/var/run'];
const IGNORED_SERVICE_KEYS: Readonly<Record<string, string>> = {
  container_name: 'Shipkeep names containers itself',
  hostname: 'services are reached by their service name',
  networks: 'every service runs on the application network',
  logging: 'logs are collected by the agent',
  stdin_open: 'containers run without a terminal',
  tty: 'containers run without a terminal',
};
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,38}$/;
const VOLUME_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const USER = /^[A-Za-z0-9_-]{1,32}(:[A-Za-z0-9_-]{1,32})?$/;
// The same pattern as `build.image` in shipkeep.schema.json.
const IMAGE =
  /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
const SHELL_CHARACTERS = /[;|&$<>()`'"\\*?#~\n\r]/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::?[-+?])[^}]*)?\}/g;
const DURATION_PART = /([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)/g;
const HEALTH_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?(\/[^\s'"]*)?/;

type Node = Record<string, unknown>;
const isRecord = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isScalarText = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const bytes = (text: string): number => new TextEncoder().encode(text).length;
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

class Report {
  readonly issues: ComposeIssue[] = [];
  readonly warnings: ComposeIssue[] = [];
  issue(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
  }
  warn(path: string, message: string): void {
    if (this.warnings.length < MAX_ISSUES) this.warnings.push({ path, message });
  }
}

/** Parses and validates; never throws on any input. */
export function parseCompose(text: string): ComposeResult {
  if (bytes(text) > MAX_COMPOSE_BYTES)
    return failure('', `the file is larger than ${String(MAX_COMPOSE_BYTES)} bytes`);
  let document: unknown;
  try {
    document = parseYaml(text, {
      version: '1.2',
      schema: 'core',
      merge: true,
      uniqueKeys: true,
      maxAliasCount: 50,
      prettyErrors: false,
    });
  } catch {
    // Parser messages quote the input, and the input may hold secrets.
    return failure('', 'this is not valid YAML');
  }
  if (!isRecord(document)) return failure('', 'a Compose file is a mapping');
  const report = new Report();
  const volumes = topLevel(document, report);
  const services = document['services'];
  if (!isRecord(services) || Object.keys(services).length === 0) {
    report.issue('services', 'at least one service is required');
    return { ok: false, issues: report.issues };
  }
  if (Object.keys(services).length > MAX_SERVICES) {
    report.issue('services', `at most ${String(MAX_SERVICES)} services are allowed`);
    return { ok: false, issues: report.issues };
  }
  const parsed = Object.entries(services).map(([name, value]) =>
    service(name, value, volumes, report),
  );
  checkDependencies(parsed, report);
  if (report.issues.length) return { ok: false, issues: report.issues };
  return {
    ok: true,
    file: { services: parsed, volumes: [...volumes] },
    warnings: report.warnings,
  };
}

function failure(path: string, message: string): ComposeResult {
  return { ok: false, issues: [{ path, message }] };
}

function topLevel(document: Node, report: Report): ReadonlySet<string> {
  for (const key of Object.keys(document)) {
    if (['services', 'volumes', 'networks', 'version', 'name'].includes(key)) continue;
    if (key.startsWith('x-')) continue;
    report.issue(key, 'this top-level key is not supported');
  }
  const networks = document['networks'];
  if (isRecord(networks))
    for (const [name, value] of Object.entries(networks))
      if (value !== null && !(isRecord(value) && Object.keys(value).length === 0))
        report.issue(
          `networks.${name}`,
          'network settings are not supported: drivers and external networks reach the host',
        );
  const declared = new Set<string>();
  const volumes = document['volumes'];
  if (volumes === undefined || volumes === null) return declared;
  if (!isRecord(volumes)) {
    report.issue('volumes', 'must be a mapping');
    return declared;
  }
  for (const [name, value] of Object.entries(volumes)) {
    const path = `volumes.${name}`;
    if (!VOLUME_NAME.test(name)) {
      report.issue(path, 'a volume name holds lowercase letters, digits, hyphens and underscores');
      continue;
    }
    // `driver_opts` can bind any host path, and `external` adopts a volume Shipkeep does not manage.
    if (value !== null && !(isRecord(value) && Object.keys(value).length === 0)) {
      report.issue(path, 'volume settings are not supported: declare it empty');
      continue;
    }
    declared.add(name);
  }
  return declared;
}

function service(
  name: string,
  value: unknown,
  volumes: ReadonlySet<string>,
  report: Report,
): ComposeService {
  const path = `services.${name}`;
  if (!SERVICE_NAME.test(name))
    report.issue(
      path,
      'a service name starts with a lowercase letter and holds lowercase letters, digits and hyphens',
    );
  const node = isRecord(value) ? value : {};
  if (!isRecord(value)) report.issue(path, 'a service is a mapping');
  const known = new Set([
    'image',
    'command',
    'environment',
    'ports',
    'expose',
    'volumes',
    'tmpfs',
    'depends_on',
    'restart',
    'healthcheck',
    'labels',
    'user',
    'working_dir',
    'read_only',
    'cap_add',
    'security_opt',
    'stop_grace_period',
    'deploy',
    'mem_limit',
    'cpus',
  ]);
  for (const key of Object.keys(node)) {
    const dangerous = Object.hasOwn(DANGEROUS, key) ? DANGEROUS[key] : undefined;
    const ignored = Object.hasOwn(IGNORED_SERVICE_KEYS, key)
      ? IGNORED_SERVICE_KEYS[key]
      : undefined;
    if (dangerous) report.issue(`${path}.${key}`, `not allowed: ${dangerous}`);
    else if (ignored) report.warn(`${path}.${key}`, `ignored: ${ignored}`);
    else if (!known.has(key) && !key.startsWith('x-'))
      report.issue(`${path}.${key}`, 'this key is not supported');
  }
  const { env, references } = environment(node['environment'], `${path}.environment`, report);
  securityOptions(node['security_opt'], `${path}.security_opt`, report);
  const resources = limits(node, path, report);
  const ports = servicePorts(node, path, report);
  return {
    name,
    image: image(node['image'], `${path}.image`, report),
    command: command(node['command'], `${path}.command`, report),
    env,
    references,
    ports,
    mounts: mounts(node, path, volumes, report),
    dependsOn: dependsOn(node['depends_on'], `${path}.depends_on`, report),
    restart: restart(node['restart'], `${path}.restart`, report),
    health: health(node['healthcheck'], `${path}.healthcheck`, report),
    labels: labels(node['labels'], `${path}.labels`, report),
    user: pattern(node['user'], `${path}.user`, USER, 'must look like 1000 or 1000:1000', report),
    workingDir: workingDir(node['working_dir'], `${path}.working_dir`, report),
    readOnlyRootfs: flag(node['read_only'], `${path}.read_only`, report),
    capAdd: capabilities(node['cap_add'], `${path}.cap_add`, report),
    stopTimeoutMs: stopTimeout(node['stop_grace_period'], `${path}.stop_grace_period`, report),
    ...resources,
  };
}

/** The agent always sets no-new-privileges, so asking for it adds nothing; anything else weakens. */
function securityOptions(value: unknown, path: string, report: Report): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    report.issue(path, 'must be a list');
    return;
  }
  for (const item of value as readonly unknown[])
    if (item !== 'no-new-privileges' && item !== 'no-new-privileges:true')
      report.issue(path, 'seccomp, AppArmor and other security profiles cannot be changed');
}

function image(value: unknown, path: string, report: Report): string {
  if (typeof value !== 'string' || value === '') {
    report.issue(path, 'every service needs an image');
    return '';
  }
  if (value.includes('$')) report.issue(path, 'variables cannot be used in an image');
  else if (value.length > 512 || !IMAGE.test(value))
    report.issue(path, 'this is not a valid image reference');
  return value;
}

/** No shell is ever implied (SPEC 2.2): a string is split only when a shell would change nothing. */
function command(value: unknown, path: string, report: Report): readonly string[] {
  if (value === undefined || value === null) return [];
  let argv: readonly unknown[];
  if (typeof value === 'string') {
    if (SHELL_CHARACTERS.test(value)) {
      report.issue(path, 'write this as a list of arguments: no shell runs it');
      return [];
    }
    argv = value.trim().split(/\s+/).filter(Boolean);
  } else if (Array.isArray(value)) argv = value as readonly unknown[];
  else {
    report.issue(path, 'must be a list of arguments');
    return [];
  }
  if (argv.length > MAX_ARGUMENTS) {
    report.issue(path, `at most ${String(MAX_ARGUMENTS)} arguments are allowed`);
    return [];
  }
  const result: string[] = [];
  for (const item of argv) {
    if (!isScalarText(item)) {
      report.issue(path, 'every argument must be text');
      return [];
    }
    const text = String(item);
    if (bytes(text) > MAX_ARGUMENT_BYTES || text.includes('\0')) {
      report.issue(path, `an argument is limited to ${String(MAX_ARGUMENT_BYTES)} bytes`);
      return [];
    }
    if (text.includes('${')) {
      report.issue(path, 'variables are only expanded in `environment`');
      return [];
    }
    result.push(text);
  }
  return result;
}

function environment(
  value: unknown,
  path: string,
  report: Report,
): { env: Record<string, string>; references: string[] } {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  const add = (key: string, raw: unknown) => {
    if (!ENV_KEY.test(key)) {
      report.issue(path, 'a variable name holds letters, digits and underscores');
      return;
    }
    if (raw === null || raw === undefined) {
      // A bare name means "copy it from the host", which must never reach the control plane's.
      report.issue(`${path}.${key}`, 'needs a value: nothing is inherited from the host');
      return;
    }
    if (!isScalarText(raw)) {
      report.issue(`${path}.${key}`, 'must be text');
      return;
    }
    const text = String(raw);
    env[key] = text;
    for (const match of text.matchAll(REFERENCE)) if (match[1]) names.add(match[1]);
  };
  if (value === undefined || value === null) return { env, references: [] };
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) {
      if (typeof item !== 'string') {
        report.issue(path, 'list items look like NAME=value');
        continue;
      }
      const separator = item.indexOf('=');
      if (separator < 0) add(item, null);
      else add(item.slice(0, separator), item.slice(separator + 1));
    }
  } else if (isRecord(value)) for (const [key, raw] of Object.entries(value)) add(key, raw);
  else report.issue(path, 'must be a mapping or a list');
  return { env, references: [...names].sort() };
}

function port(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,5}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function servicePorts(node: Node, path: string, report: Report): readonly number[] {
  const found = new Set<number>();
  const list = (key: string): readonly unknown[] => {
    const value = node[key];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value as readonly unknown[];
    report.issue(`${path}.${key}`, 'must be a list');
    return [];
  };
  list('ports').forEach((entry, index) => {
    const where = `${path}.ports[${String(index)}]`;
    const target = publishedPort(entry, where, report);
    if (target !== null) found.add(target);
  });
  list('expose').forEach((entry, index) => {
    const target = port(entry);
    if (target === null)
      report.issue(`${path}.expose[${String(index)}]`, 'this is not a valid port');
    else found.add(target);
  });
  return [...found].sort((left, right) => left - right);
}

/** Only the container port is kept: publishing on the host would bypass routing and collide. */
function publishedPort(entry: unknown, where: string, report: Report): number | null {
  let target: number | null;
  let published = false;
  if (isRecord(entry)) {
    if (entry['protocol'] !== undefined && entry['protocol'] !== 'tcp') {
      report.issue(where, 'only TCP ports are supported');
      return null;
    }
    target = port(entry['target']);
    published = entry['published'] !== undefined;
  } else if (typeof entry === 'number') target = port(entry);
  else if (typeof entry === 'string') {
    if (entry.includes('$') || entry.includes('[')) {
      report.issue(where, 'write the port without variables or IPv6 addresses');
      return null;
    }
    const [address = '', protocol = 'tcp', ...more] = entry.split('/');
    if (protocol !== 'tcp' || more.length) {
      report.issue(where, 'only TCP ports are supported');
      return null;
    }
    const parts = address.split(':');
    if (parts.length > 3 || address.includes('-')) {
      report.issue(where, 'port ranges are not supported');
      return null;
    }
    target = port(parts.at(-1));
    published = parts.length > 1;
  } else target = null;
  if (target === null) {
    report.issue(where, 'this is not a valid port');
    return null;
  }
  if (published)
    report.warn(where, 'not published on the server: route traffic with `expose` in shipkeep.yml');
  return target;
}

function safeContainerPath(value: string): string | null {
  if (!value.startsWith('/') || value.length > 4096) return 'must be an absolute path';
  if (hasControl(value)) return 'holds control characters';
  const segments = value.split('/').filter(Boolean);
  if (segments.includes('..') || segments.includes('.')) return 'cannot hold `.` or `..`';
  if (!segments.length) return 'cannot be the root of the container';
  const clean = `/${segments.join('/')}`;
  if (FORBIDDEN_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`)))
    return `cannot be under ${FORBIDDEN_ROOTS.join(', ')}`;
  return null;
}

function mounts(
  node: Node,
  path: string,
  volumes: ReadonlySet<string>,
  report: Report,
): readonly ComposeMount[] {
  const result: ComposeMount[] = [];
  const named = (source: string, target: string, readOnly: boolean, where: string) => {
    const problem = safeContainerPath(target);
    if (problem) report.issue(where, `the container path ${problem}`);
    else if (!volumes.has(source))
      report.issue(where, `the volume ${source} is not declared under \`volumes\``);
    else result.push({ kind: 'volume', volume: source, target, readOnly });
  };
  const raw = node['volumes'];
  if (Array.isArray(raw))
    (raw as readonly unknown[]).forEach((entry, index) => {
      const where = `${path}.volumes[${String(index)}]`;
      if (typeof entry === 'string') {
        if (entry.includes('$')) {
          report.issue(where, 'variables cannot be used in a volume');
          return;
        }
        const parts: readonly (string | undefined)[] = entry.split(':');
        const [source = '', target, mode, ...more] = parts;
        if (target === undefined) {
          report.issue(where, 'anonymous volumes are not supported: declare a named one');
          return;
        }
        if (more.length || (mode !== undefined && mode !== 'ro' && mode !== 'rw')) {
          report.issue(where, 'mount options other than ro and rw are not supported');
          return;
        }
        if (!VOLUME_NAME.test(source)) {
          report.issue(where, bindMessage(source));
          return;
        }
        named(source, target, mode === 'ro', where);
      } else if (isRecord(entry)) {
        const { type, source, target, read_only: readOnly } = entry;
        const allowed = new Set(['type', 'source', 'target', 'read_only']);
        if (Object.keys(entry).some((key) => !allowed.has(key)))
          report.issue(where, 'only type, source, target and read_only are supported');
        else if (type === 'volume' && typeof source === 'string' && typeof target === 'string') {
          if (VOLUME_NAME.test(source)) named(source, target, readOnly === true, where);
          else report.issue(where, 'this is not a valid volume name');
        } else if (type === 'tmpfs' && typeof target === 'string') {
          const problem = safeContainerPath(target);
          if (problem) report.issue(where, `the container path ${problem}`);
          else result.push({ kind: 'tmpfs', target });
        } else report.issue(where, bindMessage(typeof source === 'string' ? source : ''));
      } else report.issue(where, 'this is not a valid volume');
    });
  else if (raw !== undefined && raw !== null) report.issue(`${path}.volumes`, 'must be a list');
  const tmpfs = node['tmpfs'];
  const entries: readonly unknown[] =
    typeof tmpfs === 'string' ? [tmpfs] : Array.isArray(tmpfs) ? (tmpfs as readonly unknown[]) : [];
  if (tmpfs !== undefined && tmpfs !== null && typeof tmpfs !== 'string' && !Array.isArray(tmpfs))
    report.issue(`${path}.tmpfs`, 'must be a path or a list of paths');
  entries.forEach((entry, index) => {
    const where = `${path}.tmpfs[${String(index)}]`;
    const problem = typeof entry === 'string' ? safeContainerPath(entry) : 'must be a path';
    if (problem) report.issue(where, `the container path ${problem}`);
    else if (typeof entry === 'string') result.push({ kind: 'tmpfs', target: entry });
  });
  return result;
}

function bindMessage(source: string): string {
  return source.includes('docker.sock')
    ? 'the Docker socket can never be mounted: it gives full control of the server'
    : 'host paths cannot be mounted: use a named volume declared under `volumes`';
}

function dependsOn(value: unknown, path: string, report: Report): readonly string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if ((value as readonly unknown[]).every((item) => typeof item === 'string'))
      return value as readonly string[];
    report.issue(path, 'must list service names');
    return [];
  }
  if (isRecord(value)) return Object.keys(value);
  report.issue(path, 'must list service names');
  return [];
}

function checkDependencies(services: readonly ComposeService[], report: Report): void {
  const graph = new Map(services.map((item) => [item.name, item.dependsOn]));
  for (const item of services)
    for (const dependency of item.dependsOn)
      if (!graph.has(dependency))
        report.issue(`services.${item.name}.depends_on`, 'names a service that does not exist');
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): boolean => {
    const seen = state.get(name);
    if (seen) return seen === 'visiting';
    state.set(name, 'visiting');
    const cyclic = (graph.get(name) ?? []).some(visit);
    state.set(name, 'done');
    return cyclic;
  };
  for (const item of services)
    if (!state.has(item.name) && visit(item.name)) {
      report.issue(
        `services.${item.name}.depends_on`,
        'services cannot depend on each other in a cycle',
      );
      return;
    }
}

function restart(value: unknown, path: string, report: Report): ComposeService['restart'] {
  switch (value) {
    case undefined:
    case null:
    case 'no':
    case false:
      return 'never';
    case 'always':
    case 'unless-stopped':
      return 'always';
    case 'on-failure':
      return 'on-failure';
    default:
      report.issue(path, 'must be no, always, unless-stopped or on-failure');
      return 'never';
  }
}

/**
 * The agent probes over HTTP or TCP and never runs a command, so a health command is only read for
 * the URL it would have fetched. Anything else is dropped with a warning; it is never executed.
 */
function health(value: unknown, path: string, report: Report): ComposeHealth | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    report.issue(path, 'must be a mapping');
    return null;
  }
  if (value['disable'] === true) return null;
  const test = value['test'];
  const text = Array.isArray(test)
    ? (test as readonly unknown[]).filter(isScalarText).map(String).join(' ')
    : typeof test === 'string'
      ? test
      : '';
  if (text === 'NONE') return null;
  const form = text.replace(/^(CMD-SHELL|CMD)\s+/, '');
  const match = /^(curl|wget)\s/.test(form) ? HEALTH_URL.exec(form) : null;
  if (!match) {
    report.warn(
      path,
      'dropped: only an HTTP check on localhost can be translated, and no command is ever run',
    );
    return null;
  }
  const probePort = match[1] ? port(match[1]) : null;
  if (match[1] && probePort === null) {
    report.issue(path, 'this is not a valid port');
    return null;
  }
  return { kind: 'http', path: match.at(2) ?? '/', port: probePort };
}

function labels(value: unknown, path: string, report: Report): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const add = (key: string, raw: unknown) => {
    if (!LABEL_KEY.test(key)) report.issue(path, 'this is not a valid label name');
    // The agent trusts `sk.` labels to know what it manages.
    else if (key === 'sk' || key.startsWith('sk.'))
      report.issue(`${path}.${key}`, 'the sk. namespace is reserved');
    else if (!isScalarText(raw)) report.issue(`${path}.${key}`, 'must be text');
    else if (bytes(String(raw)) > 1024) report.issue(`${path}.${key}`, 'is too long');
    else result[key] = String(raw);
  };
  if (value === undefined || value === null) return result;
  if (Array.isArray(value))
    for (const item of value as readonly unknown[]) {
      if (typeof item !== 'string') {
        report.issue(path, 'list items look like name=value');
        continue;
      }
      const separator = item.indexOf('=');
      add(
        separator < 0 ? item : item.slice(0, separator),
        separator < 0 ? '' : item.slice(separator + 1),
      );
    }
  else if (isRecord(value)) for (const [key, raw] of Object.entries(value)) add(key, raw);
  else report.issue(path, 'must be a mapping or a list');
  return result;
}

function pattern(
  value: unknown,
  path: string,
  rule: RegExp,
  message: string,
  report: Report,
): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !rule.test(text)) {
    report.issue(path, message);
    return null;
  }
  return text;
}

function workingDir(value: unknown, path: string, report: Report): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.split('/').includes('..') ||
    hasControl(value) ||
    value.includes('$')
  ) {
    report.issue(path, 'must be an absolute path');
    return null;
  }
  return value;
}

function flag(value: unknown, path: string, report: Report): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  report.issue(path, 'must be true or false');
  return false;
}

function capabilities(value: unknown, path: string, report: Report): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    report.issue(path, 'must be a list');
    return [];
  }
  const result: string[] = [];
  for (const item of value as readonly unknown[]) {
    const name = typeof item === 'string' ? item.replace(/^CAP_/, '') : '';
    if (CAPABILITIES.has(name)) result.push(name);
    else report.issue(path, `only ${[...CAPABILITIES].join(', ')} can be added`);
  }
  return result;
}

function durationMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(DURATION_PART)) {
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
    total += Number(match[1]) * unit;
    consumed += match[0].length;
  }
  return consumed === value.length ? total : null;
}

function stopTimeout(value: unknown, path: string, report: Report): number | null {
  if (value === undefined || value === null) return null;
  const parsed = durationMs(value);
  if (parsed === null || parsed > MAX_STOP_MS) {
    report.issue(path, 'must be a duration such as 30s, of at most 10m');
    return null;
  }
  return parsed;
}

function limits(
  node: Node,
  path: string,
  report: Report,
): { cpuMillis: number; memoryBytes: number } {
  let cpu: unknown = node['cpus'];
  let memory: unknown = node['mem_limit'];
  const deploy = node['deploy'];
  if (deploy !== undefined && deploy !== null) {
    const allowed = isRecord(deploy) && Object.keys(deploy).every((key) => key === 'resources');
    const resources = isRecord(deploy) ? deploy['resources'] : undefined;
    const limit = isRecord(resources) ? resources['limits'] : undefined;
    if (!allowed)
      report.issue(
        `${path}.deploy`,
        'only resources.limits is supported: placement comes from shipkeep.yml',
      );
    else if (isRecord(limit)) {
      cpu = limit['cpus'] ?? cpu;
      memory = limit['memory'] ?? memory;
    }
  }
  return {
    cpuMillis: cpuValue(cpu, `${path}.cpus`, report),
    memoryBytes: memoryValue(memory, `${path}.mem_limit`, report),
  };
}

function cpuValue(value: unknown, path: string, report: Report): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'number' ? String(value) : value;
  const parsed =
    typeof text === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(text)
      ? Math.round(Number(text) * 1000)
      : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 1_024_000) {
    report.issue(path, 'must be a number of CPUs, such as 0.5');
    return 0;
  }
  return parsed;
}

function memoryValue(value: unknown, path: string, report: Report): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'number' ? String(value) : value;
  const match =
    typeof text === 'string' ? /^([0-9]+)\s*(b|k|kb|m|mb|g|gb|kib|mib|gib)?$/i.exec(text) : null;
  const unit = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 2 ** 20,
    mb: 2 ** 20,
    mib: 2 ** 20,
    g: 2 ** 30,
    gb: 2 ** 30,
    gib: 2 ** 30,
  }[(match?.[2] ?? 'b').toLowerCase() as 'b'];
  const parsed = match?.[1] ? Number(match[1]) * unit : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    report.issue(path, 'must be a size, such as 512m');
    return 0;
  }
  return parsed;
}
