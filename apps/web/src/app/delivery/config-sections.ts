import { type ShipkeepConfig } from '@shipkeep/config-schema';

import { type Block, type CellInput, type FieldItem } from '../dashboard/screen-model';
import { AMBER, GREEN, GREY, RED } from '../dashboard/format';
import { type SectionCopy } from './application-design';
import { type DomainStatus, type Release, type Replica, type SecretMetadata } from './delivery-api';

export interface SectionData {
  readonly config: Partial<ShipkeepConfig>;
  readonly configSha: string;
  readonly release: Release | undefined;
  readonly secrets: readonly SecretMetadata[];
  readonly domains: readonly DomainStatus[];
  readonly replicas: readonly Replica[];
}

const YML = 'shipkeep.yml';
const field = (l: string, v: string | undefined, extra: Partial<FieldItem> = {}): FieldItem => ({
  l,
  v: v === undefined || v === '' ? '—' : v,
  tag: YML,
  ...extra,
});
const words = (command: readonly string[] | undefined) => command?.join(' ');
const mono = (t: string, fg?: string): CellInput => ({ t, mono: true, ...(fg ? { fg } : {}) });
const state = (t: string, color: string): CellInput => ({ t, fg: color, dot: color });
const note = (text: string): Block => ({ type: 'note', text });

/**
 * Whether a domain reaches a server running the application, in words (PLAN M3.6b1). A failed
 * lookup and servers without declared addresses are both "cannot tell", with the reason.
 */
export function domainMatch(domain: DomainStatus): CellInput {
  switch (domain.match) {
    case 'serving':
      return state('a server running it', GREEN);
    case 'partial':
      return state('partly a server running it', AMBER);
    case 'elsewhere':
      return state('no server running it', RED);
    case 'not_running':
      return state('no server runs it yet', GREY);
    default:
      return state(
        domain.status === 'unknown' ? 'cannot tell yet' : 'cannot tell: address not set',
        AMBER,
      );
  }
}

/**
 * The application settings of the design, filled from the current shipkeep.yml and the API. They
 * are read-only here: the configuration changes through the shipkeep.yml section, so that the file
 * stays the single source of truth (product principle 2).
 */
export function configSection(key: string, data: SectionData): SectionCopy | null {
  const { config } = data;
  switch (key) {
    case 'general':
      return {
        title: 'General',
        desc: 'Identity and build of the application. Every value comes from its shipkeep.yml.',
        blocks: [
          {
            type: 'fields',
            items: [
              field('Name', config.name, { h: 'Unique within the environment' }),
              field('Build', config.build?.type, { h: 'Dockerfile, Railpack, Nixpacks or image' }),
              field('Exposed port', config.run?.port.toString()),
              field('Start command', words(config.run?.command), { h: 'Empty: the image default' }),
              field('Release command', words(config.release?.command), {
                h: 'Runs once before switchover',
              }),
              field('Deploy strategy', config.deploy?.strategy ?? 'rolling'),
            ],
          },
        ],
      };
    case 'source':
      return {
        title: 'Source',
        desc: 'Where the image comes from. Repository builds and push webhooks arrive with Git sources.',
        blocks: [
          {
            type: 'fields',
            items: [
              field(
                'Provider',
                config.build?.type === 'image' ? 'Container image' : 'Repository build',
                {
                  mono: false,
                },
              ),
              field('Image', config.build?.image),
              field('Build context', config.build?.context),
              field('Dockerfile', config.build?.dockerfile),
              { l: 'Running digest', v: data.release?.imageDigest ?? '—', mono: true },
              { l: 'Configuration version', v: data.configSha.slice(0, 12), mono: true },
            ],
          },
        ],
      };
    case 'domains':
      return {
        title: 'Domains',
        desc: "Automatic HTTPS via Let's Encrypt once the domain points at the server.",
        blocks: data.domains.length
          ? [
              {
                type: 'table',
                // The answer comes second, so it stays visible on a phone before the table scrolls.
                cols: 'minmax(0,1.2fr) minmax(0,1.6fr) minmax(0,0.8fr) minmax(0,1fr)',
                heads: ['Domain', 'Points at', 'DNS', 'Addresses'],
                rows: data.domains.map((domain) => [
                  mono(domain.hostname, '#EDEDEF'),
                  domainMatch(domain),
                  domain.status === 'public'
                    ? state('public', GREEN)
                    : domain.status === 'none'
                      ? state('no record', AMBER)
                      : domain.status === 'private'
                        ? state('private address', RED)
                        : state('lookup failed', AMBER),
                  mono(domain.addresses.join(', ') || '—', '#8B8B93'),
                ]),
              },
              note(
                'Point each domain at a public address of a server running this application. Administrators set these addresses on the Servers page. Certificates are issued automatically once it answers on ports 80 and 443.',
              ),
            ]
          : [note('No domain yet. Add one under domains: in shipkeep.yml.')],
      };
    case 'env': {
      const env = Object.entries(config.env ?? {});
      const known = new Map(data.secrets.map((secret) => [secret.name, secret]));
      const rows: (readonly CellInput[])[] = [
        ...env.map(([name, value]): readonly CellInput[] => [
          mono(name),
          mono(value ?? '', '#8B8B93'),
          'run',
          { t: YML, dim: true },
        ]),
        ...(config.secrets ?? []).map((name): readonly CellInput[] => {
          const secret = known.get(name);
          return [
            mono(name),
            mono('••••••••', '#7E7E87'),
            secret ? state('secret', AMBER) : state('not set', RED),
            { t: secret ? secret.updatedAt.slice(0, 10) : '—', dim: true },
          ];
        }),
      ];
      return {
        title: 'Variables and secrets',
        desc: 'Secrets are write-only: encrypted, never read back by the interface, sent only to the agent that uses them.',
        blocks: rows.length
          ? [
              {
                type: 'table',
                cols: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr)',
                heads: ['Name', 'Value', 'Scope', 'Modified'],
                rows,
              },
              note('Secret values are set in the environment, under Variables and secrets.'),
            ]
          : [note('No variable yet. Declare them under env: and secrets: in shipkeep.yml.')],
      };
    }
    case 'storage':
      return {
        title: 'Persistent storage',
        desc: 'Volumes mounted into containers. An app with a volume stays attached to its server.',
        blocks: config.volumes?.length
          ? [
              {
                type: 'table',
                cols: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.9fr)',
                heads: ['Volume', 'Path', 'Backup'],
                rows: config.volumes.map((volume) => [
                  mono(volume.name),
                  mono(volume.path, '#8B8B93'),
                  volume.backup ? state(volume.backup.schedule, GREEN) : { t: 'none', dim: true },
                ]),
              },
            ]
          : [note('No volume. Declare one under volumes: in shipkeep.yml.')],
      };
    case 'placement':
      return {
        title: 'Placement',
        ours: 1,
        desc: 'Where replicas run. Shipkeep spreads them across servers when it can.',
        blocks: [
          {
            type: 'fields',
            items: [
              field('Replicas', String(config.scale?.replicas ?? 1)),
              field('Spread', config.scale?.placement?.spread ?? 'node'),
              field(
                'Labels',
                Object.entries(config.scale?.placement?.labels ?? {})
                  .map(([k, v]) => `${k}=${v ?? ''}`)
                  .join(', '),
              ),
              field('Servers', config.scale?.placement?.nodes?.join(', ')),
            ],
          },
          {
            type: 'table',
            title: 'Instances',
            aside: 'as reported by the agents',
            cols: 'minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.8fr)',
            heads: ['Container', 'Server', 'State'],
            rows: data.replicas.length
              ? data.replicas.map((replica) => [
                  mono(replica.container || `#${String(replica.replica)}`),
                  mono(replica.nodeName),
                  replica.state === 'running'
                    ? state('running', GREEN)
                    : replica.state
                      ? state(
                          replica.state,
                          ['missing', 'dead', 'exited'].includes(replica.state) ? RED : AMBER,
                        )
                      : { t: 'not reported yet', dim: true },
                ])
              : [[{ t: 'No instance running yet.', dim: true }, '', '']],
          },
        ],
      };
    case 'health': {
      const check = config.run?.healthcheck;
      return {
        title: 'Health check',
        desc: 'A new replica only receives traffic after it answers here.',
        blocks: [
          {
            type: 'fields',
            items: [
              field('Path', check ? `GET ${check.path}` : undefined),
              field('Interval', check?.interval ?? 'default'),
              field('Timeout', check?.timeout ?? 'default'),
              field('Start period', check?.start_period ?? 'default', { h: 'Ignored at startup' }),
              field('Healthy after', check?.healthy_threshold?.toString() ?? 'default'),
              field('Unhealthy after', check?.unhealthy_threshold?.toString() ?? 'default'),
            ],
          },
        ],
      };
    }
    case 'limits':
      return {
        title: 'Resource limits',
        desc: 'Per replica. Placement takes it into account when choosing a server.',
        blocks: [
          {
            type: 'fields',
            items: [
              field('CPU', config.resources?.cpu ?? 'no limit'),
              field('Memory', config.resources?.memory ?? 'no limit'),
              field('Replicas', String(config.scale?.replicas ?? 1)),
            ],
          },
        ],
      };
    case 'previews':
      return {
        title: 'Previews',
        desc: 'One environment per pull request, destroyed on merge.',
        blocks: [
          note(
            'Preview environments are not built yet: these settings are kept for when they are.',
          ),
          {
            type: 'fields',
            items: [
              field('Previews per PR', config.previews?.enabled ? 'on' : 'off'),
              field('Lifetime', config.previews?.ttl),
              field('At most', config.previews?.max_active?.toString()),
              field('Database', config.previews?.database),
            ],
          },
        ],
      };
    default:
      return null;
  }
}
