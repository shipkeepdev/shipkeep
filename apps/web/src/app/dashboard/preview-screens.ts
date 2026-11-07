import { type Screen } from './screen-model';

/**
 * Sample screens from the design, shown where the control plane has no data source yet. Every page
 * built from them carries the "Preview" label, so nobody mistakes them for live data.
 */
export type PreviewView =
  | 'projects'
  | 'project'
  | 'env'
  | 'server'
  | 'db'
  | 'service'
  | 'deploy'
  | 'integrations'
  | 'sharedvars'
  | 'notifs'
  | 'tags'
  | 'org'
  | 'settings'
  | 'profile'
  | 'vulns'
  | 'onboarding'
  | 'terminal';

export const PREVIEW_SCREENS: Readonly<Record<PreviewView, Screen>> = {
  projects: {
    label: '09 Projects',
    title: 'Projects',
    sub: 'A project groups the environments of a client or a product. Each environment has its own resources, variables and permissions.',
    crumbs: ['Atelier Nord', 'Projects'],
    actions: [['New project', 'plus', 1]],
    blocks: [
      {
        type: 'cards',
        min: '280px',
        items: [
          {
            name: 'Client Lumen',
            sub: 'production · staging · preview',
            icon: 'folder',
            desc: 'Billing and customer site.',
            meta: [
              ['apps', '9 resources'],
              ['server-2', '3 servers'],
              ['users', '4 members'],
            ],
            go: 'project',
            badge: 'live',
            bc: 'oklch(0.78 0.13 155)',
          },
          {
            name: 'Client Verdi',
            sub: 'production · staging · preview',
            icon: 'folder',
            desc: 'Shop and back office.',
            meta: [
              ['apps', '7 resources'],
              ['server-2', '2 servers'],
              ['users', '3 members'],
            ],
            go: 'project',
            badge: '1 alert',
            bc: 'oklch(0.80 0.12 80)',
          },
          {
            name: 'Marketing site',
            sub: 'production · staging',
            icon: 'folder',
            desc: 'atelier-nord.fr and blog.',
            meta: [
              ['apps', '3 resources'],
              ['server-2', '1 server'],
              ['users', '2 members'],
            ],
            go: 'project',
            badge: 'live',
            bc: 'oklch(0.78 0.13 155)',
          },
          {
            name: 'Internal tools',
            sub: 'production · staging · dev',
            icon: 'folder',
            desc: 'Grafana, n8n, Metabase.',
            meta: [
              ['apps', '5 resources'],
              ['server-2', '2 servers'],
              ['users', '5 members'],
            ],
            go: 'project',
            badge: 'live',
            bc: 'oklch(0.78 0.13 155)',
          },
        ],
      },
    ],
  },
  project: {
    label: '10 Project',
    title: 'Client Lumen',
    sub: 'Three environments. Production is protected: deployments and secrets require approval.',
    crumbs: ['Atelier Nord', 'Projects', 'Client Lumen'],
    pills: [['3 environments']],
    actions: [
      ['Settings', 'settings', 0],
      ['New environment', 'plus', 1],
    ],
    blocks: [
      {
        type: 'cards',
        min: '300px',
        items: [
          {
            name: 'production',
            sub: 'protected · 2 approvers',
            icon: 'shield-check',
            hl: 1,
            desc: 'srv-par-1, srv-fra-2, srv-ams-3',
            meta: [
              ['apps', '4 apps'],
              ['database', '2 databases'],
              ['stack-2', '1 service'],
            ],
            go: 'env',
            badge: 'live',
            bc: 'oklch(0.78 0.13 155)',
          },
          {
            name: 'staging',
            sub: 'auto deploy on develop',
            icon: 'flask',
            desc: 'srv-fra-2',
            meta: [
              ['apps', '4 apps'],
              ['database', '2 databases'],
            ],
            go: 'env',
            badge: 'live',
            bc: 'oklch(0.78 0.13 155)',
          },
          {
            name: 'preview',
            sub: 'one copy per pull request',
            icon: 'git-pull-request',
            desc: 'srv-ams-3 · quota 4 previews',
            meta: [['git-pull-request', '3 active']],
            go: 'previews',
            badge: '3 active',
            bc: '#A6A6AE',
          },
        ],
      },
      {
        type: 'table',
        title: 'Project members',
        aside: 'Roles per environment',
        cols: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
        heads: ['Member', 'production', 'staging', 'preview'],
        rows: [
          [
            'Inès L.',
            {
              t: 'admin',
              dot: '#EDEDEF',
              fg: '#EDEDEF',
            },
            'admin',
            'admin',
          ],
          [
            'Marc D.',
            {
              t: 'read',
              dim: true,
            },
            'developer',
            'developer',
          ],
          [
            'Yuki T.',
            {
              t: 'read',
              dim: true,
            },
            'developer',
            'developer',
          ],
          [
            'Claire (Lumen)',
            {
              t: 'read',
              dim: true,
            },
            {
              t: 'read',
              dim: true,
            },
            {
              t: 'none',
              dim: true,
            },
          ],
        ],
      },
    ],
  },
  env: {
    label: '11 Environment',
    title: 'production',
    sub: 'Client Lumen · protected · 7 resources on 3 servers',
    crumbs: ['Atelier Nord', 'Client Lumen', 'production'],
    pills: [['protected', '#FF8A8A']],
    actions: [
      ['Clone', 'copy', 0],
      ['Variables', 'key', 0, 'sharedvars'],
      ['New resource', 'plus', 1, 'new'],
    ],
    blocks: [
      {
        type: 'stats',
        items: [
          ['apps', 'Applications', '4', '1 failing', 'oklch(0.68 0.17 25)'],
          ['database', 'Databases', '2', 'backed up 8 h ago'],
          ['stack-2', 'Services', '1', 'Grafana'],
          ['world', 'Domains', '6', 'valid certificates'],
        ],
      },
      {
        type: 'table',
        title: 'Resources',
        cols: 'minmax(0,1.5fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,0.9fr) minmax(0,0.8fr)',
        heads: ['Name', 'Type', 'Servers', 'State', 'Deployed'],
        rows: [
          {
            go: 'app',
            cells: [
              {
                t: 'api-facturation',
                logo: 'nodedotjs',
              },
              'Application',
              {
                t: '3 servers',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: '12 min ago',
                dim: true,
              },
            ],
          },
          {
            go: 'app',
            cells: [
              {
                t: 'front-lumen',
                logo: 'nextdotjs',
              },
              'Application',
              {
                t: '2 servers',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: '2 h ago',
                dim: true,
              },
            ],
          },
          {
            go: 'app',
            cells: [
              {
                t: 'worker-mails',
                logo: 'go',
              },
              'Application',
              {
                t: 'srv-fra-2',
                mono: true,
              },
              {
                t: 'failed',
                dot: 'oklch(0.68 0.17 25)',
                fg: 'oklch(0.68 0.17 25)',
              },
              {
                t: '40 min ago',
                dim: true,
              },
            ],
          },
          {
            go: 'app',
            cells: [
              {
                t: 'site-www',
                logo: 'astro',
              },
              'Application',
              {
                t: 'srv-par-1',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: 'yesterday',
                dim: true,
              },
            ],
          },
          {
            go: 'db',
            cells: [
              {
                t: 'pg-factures',
                logo: 'postgresql',
              },
              'PostgreSQL 17',
              {
                t: 'srv-par-1',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: '9 d ago',
                dim: true,
              },
            ],
          },
          {
            go: 'db',
            cells: [
              {
                t: 'redis-cache',
                logo: 'redis',
              },
              'Redis 7',
              {
                t: 'srv-fra-2',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: '9 d ago',
                dim: true,
              },
            ],
          },
          {
            go: 'service',
            cells: [
              {
                t: 'grafana',
                logo: 'grafana',
              },
              'Service · 3 containers',
              {
                t: 'srv-ams-3',
                mono: true,
              },
              {
                t: 'live',
                dot: 'oklch(0.78 0.13 155)',
                fg: 'oklch(0.78 0.13 155)',
              },
              {
                t: '3 d ago',
                dim: true,
              },
            ],
          },
        ],
      },
    ],
  },
  server: {
    label: '12 Server',
    title: 'srv-par-1',
    sub: 'Paris · Hetzner CPX41 · 8 vCPU · 16 GiB · Ubuntu 24.04 · 10.42.0.1',
    crumbs: ['Atelier Nord', 'Servers', 'srv-par-1'],
    pills: [['ready', 'oklch(0.78 0.13 155)'], ['agent 0.1.0']],
    actions: [
      ['Terminal', 'terminal-2', 0, 'terminal'],
      ['Drain', 'player-pause', 0],
    ],
    sections: [
      {
        k: 'general',
        label: 'General',
        icon: 'adjustments',
        head: 'Server',
        blocks: [
          {
            type: 'stats',
            items: [
              ['cpu', 'CPU', '41 %', '8 vCPU'],
              ['device-sd-card', 'Memory', '9.8 GiB', 'of 16 GiB'],
              ['database', 'Disk', '212 GiB', 'of 320 GiB · 66%', 'oklch(0.80 0.12 80)'],
              ['box', 'Containers', '14', '11 apps · 3 system'],
            ],
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Name',
                v: 'srv-par-1',
              },
              {
                l: 'Description',
                v: 'Primary node Paris',
                mono: false,
              },
              {
                l: 'Region',
                v: 'Paris · eu-west',
                mono: false,
              },
              {
                l: 'Placement labels',
                v: 'region=par, disk=ssd, tier=prod',
              },
              {
                l: 'Accepts builds',
                toggle: false,
                h: 'Builds run on srv-ams-6',
              },
              {
                l: 'Accepts new instances',
                toggle: true,
              },
            ],
          },
        ],
      },
      {
        k: 'agent',
        label: 'Agent',
        icon: 'plug-connected',
        ours: 1,
        title: 'Shipkeep agent',
        desc: 'The agent calls the control plane over outbound mTLS. No inbound port, no SSH key.',
        blocks: [
          {
            type: 'stats',
            items: [
              ['heartbeat', 'Last heartbeat', '2 s ago', 'every 5 s', 'oklch(0.78 0.13 155)'],
              ['clock', 'Lease', '58 s', 'continuously renewed'],
              ['versions', 'Epoch', '412', 'last reconnect 3 d ago'],
              ['package', 'Version', '0.1.0', 'up to date'],
            ],
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Stream',
                v: 'cp.atelier-nord.fr:7443 · mTLS 1.3',
              },
              {
                l: 'Certificate',
                v: 'expires in 21 d · auto rotation at D-7',
              },
              {
                l: 'CA fingerprint',
                v: 'sha256:9f3a…c41e',
              },
              {
                l: 'Agent memory',
                v: '38 MiB',
              },
            ],
          },
          {
            type: 'code',
            title: 'Agent log',
            mh: '220px',
            lines: [
              {
                p: '10:22:41 ',
                t: 'heartbeat ok · lease 60s · epoch 412',
              },
              {
                p: '10:13:06 ',
                t: 'action UpsertRoute api-facturation → ok',
              },
              {
                p: '10:12:58 ',
                t: 'action StartContainer api-facturation-7f9c → ok',
              },
              {
                p: '09:58:40 ',
                t: 'action StopContainer refused · lease expired on srv-fra-4 side',
                c: 'oklch(0.80 0.12 80)',
              },
              {
                p: '03:00:00 ',
                t: 'docker cleanup · 4.2 GiB freed',
              },
            ],
          },
        ],
      },
      {
        k: 'resources',
        label: 'Resources',
        icon: 'apps',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.7fr) minmax(0,0.7fr) minmax(0,0.8fr)',
            heads: ['Resource', 'Project', 'CPU', 'Memory', 'State'],
            rows: [
              {
                go: 'app',
                cells: [
                  {
                    t: 'api-facturation',
                    logo: 'nodedotjs',
                  },
                  'Lumen · production',
                  '0,4',
                  '612 MiB',
                  {
                    t: 'healthy',
                    dot: 'oklch(0.78 0.13 155)',
                    fg: 'oklch(0.78 0.13 155)',
                  },
                ],
              },
              {
                go: 'app',
                cells: [
                  {
                    t: 'site-www',
                    logo: 'astro',
                  },
                  'Lumen · production',
                  '0,1',
                  '96 MiB',
                  {
                    t: 'healthy',
                    dot: 'oklch(0.78 0.13 155)',
                    fg: 'oklch(0.78 0.13 155)',
                  },
                ],
              },
              {
                go: 'db',
                cells: [
                  {
                    t: 'pg-factures',
                    logo: 'postgresql',
                  },
                  'Lumen · production',
                  '0,6',
                  '2.1 GiB',
                  {
                    t: 'healthy',
                    dot: 'oklch(0.78 0.13 155)',
                    fg: 'oklch(0.78 0.13 155)',
                  },
                ],
              },
              {
                go: 'app',
                cells: [
                  {
                    t: 'boutique-api',
                    logo: 'nodedotjs',
                  },
                  'Verdi · production',
                  '0,3',
                  '480 MiB',
                  {
                    t: 'healthy',
                    dot: 'oklch(0.78 0.13 155)',
                    fg: 'oklch(0.78 0.13 155)',
                  },
                ],
              },
              [
                'caddy',
                {
                  t: 'system',
                  dim: true,
                },
                '0,1',
                '64 MiB',
                {
                  t: 'healthy',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'shipkeep-agent',
                {
                  t: 'system',
                  dim: true,
                },
                '0,0',
                '38 MiB',
                {
                  t: 'healthy',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'proxy',
        label: 'Proxy and certificates',
        icon: 'route',
        head: 'Network',
        blocks: [
          {
            type: 'note',
            text: 'Caddy is driven by the agent over a Unix socket. Routes only point to healthy instances.',
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Proxy',
                v: 'Caddy 2.9 · live',
              },
              {
                l: 'Exposed ports',
                v: '80, 443',
              },
              {
                l: 'HTTP → HTTPS redirect',
                toggle: true,
              },
              {
                l: 'Error page',
                v: 'Shipkeep · default',
                mono: false,
              },
            ],
          },
          {
            type: 'table',
            title: 'Certificates',
            cols: 'minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr)',
            heads: ['Domain', 'Issuer', 'Expires'],
            rows: [
              [
                {
                  t: 'factures.lumen.fr',
                  mono: true,
                },
                "Let's Encrypt",
                {
                  t: 'in 78 d',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'lumen.fr',
                  mono: true,
                },
                "Let's Encrypt",
                {
                  t: 'in 64 d',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'boutique.verdi.shop',
                  mono: true,
                },
                "Let's Encrypt",
                {
                  t: 'in 9 d · renewal',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'mesh',
        label: 'WireGuard mesh',
        icon: 'network',
        ours: 1,
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            heads: ['Peer', 'Address', 'Latency', 'Last handshake'],
            rows: [
              [
                {
                  t: 'srv-fra-2',
                  mono: true,
                },
                {
                  t: '10.42.0.2',
                  mono: true,
                },
                '9 ms',
                {
                  t: '41 s ago',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'srv-ams-3',
                  mono: true,
                },
                {
                  t: '10.42.0.3',
                  mono: true,
                },
                '12 ms',
                {
                  t: '18 s ago',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'srv-fra-4',
                  mono: true,
                },
                {
                  t: '10.42.0.4',
                  mono: true,
                },
                '—',
                {
                  t: '4 min ago',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
              [
                {
                  t: 'srv-ams-6',
                  mono: true,
                },
                {
                  t: '10.42.0.6',
                  mono: true,
                },
                '13 ms',
                {
                  t: '52 s ago',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'tunnel',
        label: 'Cloudflare Tunnel',
        icon: 'cloud',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Expose via Cloudflare Tunnel',
                toggle: false,
                h: 'No public IP or open port',
              },
              {
                l: 'Tunnel token',
                v: 'not configured',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'images',
        label: 'Docker images',
        icon: 'brand-docker',
        head: 'Docker',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.8fr) minmax(0,0.7fr) minmax(0,0.8fr) minmax(0,0.7fr)',
            heads: ['Image', 'Size', 'Created', 'Used'],
            rows: [
              [
                {
                  t: 'registry.internal/api-facturation:4f2c1a9',
                  mono: true,
                },
                '214 MB',
                '12 min ago',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'registry.internal/api-facturation:9c41e07',
                  mono: true,
                },
                '213 MB',
                'yesterday',
                {
                  t: 'rollback',
                  dim: true,
                },
              ],
              [
                {
                  t: 'postgres:17.2',
                  mono: true,
                },
                '438 MB',
                '9 d ago',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'caddy:2.9-alpine',
                  mono: true,
                },
                '52 MB',
                '1 month ago',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'registry.internal/site-www:e13f5b2',
                  mono: true,
                },
                '88 MB',
                '6 d ago',
                {
                  t: 'no',
                  dim: true,
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'cleanup',
        label: 'Docker cleanup',
        icon: 'trash',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Automatic cleanup',
                toggle: true,
              },
              {
                l: 'Schedule',
                v: '0 3 * * *',
              },
              {
                l: 'Trigger threshold',
                v: 'disk > 80%',
              },
              {
                l: 'Images to keep',
                v: 'Last 3 per app (rollback)',
              },
              {
                l: 'Delete orphaned volumes',
                toggle: false,
              },
            ],
          },
          {
            type: 'table',
            title: 'Latest runs',
            cols: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
            heads: ['Date', 'Freed', 'Result'],
            rows: [
              [
                'today 03:00',
                '4.2 GiB',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'yesterday 03:00',
                '1.8 GiB',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Nov 5 03:00',
                '0.6 GiB',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'registries',
        label: 'Registries',
        icon: 'packages',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.5fr) minmax(0,1fr) minmax(0,0.8fr)',
            heads: ['Registry', 'User', 'State'],
            rows: [
              [
                {
                  t: 'registry.internal',
                  icon: 'lock',
                },
                {
                  t: 'internal',
                  dim: true,
                },
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'ghcr.io',
                  logo: 'github',
                },
                'lumen-bot',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'docker.io',
                  logo: 'docker',
                },
                'atelier-nord',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
            add: 'Add a registry',
          },
        ],
      },
      {
        k: 'drains',
        label: 'Log export',
        icon: 'file-export',
        head: 'Operations',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Export logs',
                toggle: false,
              },
              {
                l: 'Destination',
                v: 'Axiom, New Relic, Loki or HTTP',
                mono: false,
              },
              {
                l: 'Format',
                v: 'JSON lines',
              },
            ],
          },
        ],
      },
      {
        k: 'security',
        label: 'Security',
        icon: 'shield-lock',
        blocks: [
          {
            type: 'stats',
            items: [
              [
                'shield-check',
                'System updates',
                '3',
                'available · incl. 1 security',
                'oklch(0.80 0.12 80)',
              ],
              ['bug', 'Image vulnerabilities', '2', 'high', 'oklch(0.68 0.17 25)'],
              ['key-off', 'Stored SSH keys', '0', 'by design', 'oklch(0.78 0.13 155)'],
            ],
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Automatic security updates',
                toggle: true,
                h: 'unattended-upgrades',
              },
              {
                l: 'Scan images at build',
                toggle: true,
              },
              {
                l: 'Firewall',
                v: 'inbound: 80, 443 · outbound: 7443, 51820',
              },
            ],
          },
        ],
      },
      {
        k: 'transfer',
        label: 'Transfer',
        icon: 'transfer',
        blocks: [
          {
            type: 'note',
            text: 'Moves all stateless resources to other servers, then pauses this one. Local volumes must be migrated separately.',
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Destination',
                v: 'automatic placement',
                mono: false,
              },
              {
                l: 'Affected resources',
                v: '9 stateless · 2 with volume',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'danger',
        label: 'Danger zone',
        icon: 'alert-triangle',
        blocks: [
          {
            type: 'danger',
            items: [
              ['Drain server', 'No new instances. Existing ones stay.', 'Drain'],
              [
                'Revoke agent',
                'The certificate is revoked; the agent can no longer connect.',
                'Revoke',
              ],
              [
                'Remove server',
                'Its instances are rescheduled, then it leaves the fleet.',
                'Remove',
              ],
            ],
          },
        ],
      },
    ],
  },
  db: {
    label: '13 Database',
    title: 'pg-factures',
    logo: 'postgresql',
    sub: 'PostgreSQL 17.2 · Client Lumen · production · srv-par-1 · volume pg-factures-data 18 GiB',
    crumbs: ['Atelier Nord', 'Client Lumen', 'production', 'pg-factures'],
    pills: [['live', 'oklch(0.78 0.13 155)']],
    actions: [
      ['Back up', 'database-export', 0],
      ['Restart', 'refresh', 0],
    ],
    sections: [
      {
        k: 'general',
        label: 'General',
        icon: 'adjustments',
        head: 'Database',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Name',
                v: 'pg-factures',
              },
              {
                l: 'Image',
                v: 'postgres:17.2',
              },
              {
                l: 'Database',
                v: 'invoices',
              },
              {
                l: 'User',
                v: 'invoices',
              },
              {
                l: 'Password',
                v: '••••••••••',
                tag: 'secret',
              },
              {
                l: 'Arguments',
                v: '-c shared_buffers=1GB',
              },
            ],
          },
        ],
      },
      {
        k: 'conn',
        label: 'Sign in',
        icon: 'plug',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Internal URL',
                v: 'postgres://factures:•••@pg-factures.production.lumen.internal:5432/factures',
              },
              {
                l: 'Public access',
                toggle: false,
                h: 'Exposes a port on the internet',
              },
              {
                l: 'Linked apps',
                v: 'api-facturation, worker-mails',
                mono: false,
              },
            ],
          },
          {
            type: 'note',
            tone: 'ours',
            text: 'Linked apps receive PG_FACTURES_URL automatically. The value is never shown in the interface.',
          },
        ],
      },
      {
        k: 'backups',
        label: 'Backups',
        icon: 'database-export',
        head: 'Data',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Scheduled backups',
                toggle: true,
              },
              {
                l: 'Schedule',
                v: '0 2 * * *',
              },
              {
                l: 'Destination',
                v: 's3://atelier-nord-backups/lumen',
                tag: 'encrypted',
              },
              {
                l: 'Retention',
                v: '14 daily · 8 weekly',
                mono: false,
              },
              {
                l: 'Verify by restoring every night',
                toggle: true,
              },
            ],
          },
          {
            type: 'table',
            title: 'Runs',
            cols: 'minmax(0,1fr) minmax(0,0.7fr) minmax(0,0.7fr) minmax(0,0.9fr) 80px',
            heads: ['Date', 'Size', 'Duration', 'Verification', ''],
            rows: [
              [
                'today 02:00',
                '2.1 GiB',
                '1 min 48 s',
                {
                  t: 'restored ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'Restore',
                  fg: '#EDEDEF',
                },
              ],
              [
                'yesterday 02:00',
                '2.1 GiB',
                '1 min 51 s',
                {
                  t: 'restored ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'Restore',
                  fg: '#EDEDEF',
                },
              ],
              [
                'Nov 5 02:00',
                '2.0 GiB',
                '1 min 44 s',
                {
                  t: 'restored ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'Restore',
                  fg: '#EDEDEF',
                },
              ],
              [
                'Nov 4 02:00',
                '—',
                '—',
                {
                  t: 'failed · S3 403',
                  dot: 'oklch(0.68 0.17 25)',
                  fg: 'oklch(0.68 0.17 25)',
                },
                {
                  t: '—',
                  dim: true,
                },
              ],
            ],
          },
          {
            type: 'note',
            tone: 'ours',
            text: 'An in-place restore requires typing the database name and admin approval (ADR 0013). By default, it restores into a new database.',
          },
        ],
      },
      {
        k: 'import',
        label: 'Import a dump',
        icon: 'file-import',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'File',
                v: 'drop a .sql, .dump or .tar.gz',
                mono: false,
              },
              {
                l: 'Or from S3',
                v: 's3://…',
              },
              {
                l: 'Command',
                v: 'pg_restore --clean --no-owner',
              },
            ],
          },
        ],
      },
      {
        k: 'env',
        label: 'Variables',
        icon: 'key',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr)',
            heads: ['Name', 'Value', 'Scope'],
            rows: [
              [
                {
                  t: 'POSTGRES_DB',
                  mono: true,
                },
                {
                  t: 'invoices',
                  mono: true,
                  fg: '#7E7E87',
                },
                'run',
              ],
              [
                {
                  t: 'POSTGRES_USER',
                  mono: true,
                },
                {
                  t: 'invoices',
                  mono: true,
                  fg: '#7E7E87',
                },
                'run',
              ],
              [
                {
                  t: 'POSTGRES_PASSWORD',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'secret',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'storage',
        label: 'Storage',
        icon: 'device-sd-card',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,0.7fr)',
            heads: ['Volume', 'Path', 'Size'],
            rows: [
              [
                {
                  t: 'pg-factures-data',
                  mono: true,
                },
                {
                  t: '/var/lib/postgresql/data',
                  mono: true,
                  fg: '#7E7E87',
                },
                '18 GiB',
              ],
            ],
          },
        ],
      },
      {
        k: 'health',
        label: 'Health check',
        icon: 'heartbeat',
        head: 'Run',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'Command',
                v: 'pg_isready -U factures',
              },
              {
                l: 'Interval',
                v: '10 s',
              },
            ],
          },
        ],
      },
      {
        k: 'limits',
        label: 'Limits',
        icon: 'cpu',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'CPU',
                v: '2 cores',
              },
              {
                l: 'Memory',
                v: '4 GiB',
              },
            ],
          },
        ],
      },
      {
        k: 'logs',
        label: 'Logs',
        icon: 'file-text',
        blocks: [
          {
            type: 'code',
            mh: '300px',
            lines: [
              {
                p: '10:22:01 ',
                t: 'LOG:  checkpoint complete: wrote 1204 buffers (0.9%)',
              },
              {
                p: '10:17:44 ',
                t: "LOG:  duration: 812.4 ms  statement: SELECT … FROM invoices WHERE status = 'due'",
                c: 'oklch(0.80 0.12 80)',
              },
              {
                p: '10:12:51 ',
                t: 'LOG:  migration 0042_invoice_pdf_export applied',
              },
              {
                p: '02:01:48 ',
                t: 'LOG:  backup finished · 2.1 GiB',
              },
            ],
          },
        ],
      },
      {
        k: 'danger',
        label: 'Danger zone',
        icon: 'alert-triangle',
        head: 'Operations',
        blocks: [
          {
            type: 'danger',
            items: [
              ['Stop database', 'Linked apps will lose their connection.', 'Stop'],
              [
                'Delete database',
                'Deletes the container and the volume. Backups are kept for 30 days.',
                'Delete',
              ],
            ],
          },
        ],
      },
    ],
  },
  service: {
    label: '14 Service',
    title: 'grafana',
    logo: 'grafana',
    sub: 'Compose template “Grafana” imported from Coolify · 3 containers · Internal tools · production · srv-ams-3',
    crumbs: ['Atelier Nord', 'Internal tools', 'production', 'grafana'],
    pills: [['live', 'oklch(0.78 0.13 155)']],
    actions: [
      ['Logs', 'file-text', 0],
      ['Redeploy', 'rocket', 1],
    ],
    sections: [
      {
        k: 'stack',
        label: 'Containers',
        icon: 'stack-2',
        head: 'Stack',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            heads: ['Service', 'Image', 'Exposed', 'State'],
            rows: [
              [
                {
                  t: 'grafana',
                  logo: 'grafana',
                },
                {
                  t: 'grafana/grafana:11.3.1',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'grafana.atelier-nord.fr',
                  mono: true,
                },
                {
                  t: 'healthy',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'postgres',
                  logo: 'postgresql',
                },
                {
                  t: 'postgres:16',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'internal',
                  dim: true,
                },
                {
                  t: 'healthy',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'renderer',
                  logo: 'grafana',
                },
                {
                  t: 'grafana/grafana-image-renderer',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'internal',
                  dim: true,
                },
                {
                  t: 'healthy',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'compose',
        label: 'Compose',
        icon: 'file-code',
        blocks: [
          {
            type: 'code',
            lines: [
              'services:',
              'grafana:',
              'image: grafana/grafana:11.3.1',
              'environment:',
              '- GF_SERVER_ROOT_URL=${SERVICE_URL_GRAFANA}',
              '- GF_DATABASE_URL=${PG_URL}',
              'volumes: [grafana-data:/var/lib/grafana]',
              'postgres:',
              'image: postgres:16',
            ],
          },
          {
            type: 'note',
            text: '“grafana-with-postgresql” template from the Coolify catalog (Apache-2.0).',
          },
        ],
      },
      {
        k: 'domains',
        label: 'Domains',
        icon: 'world',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,0.8fr)',
            heads: ['Domain', 'Service', 'Certificate'],
            rows: [
              [
                {
                  t: 'grafana.atelier-nord.fr',
                  mono: true,
                },
                'grafana:3000',
                {
                  t: 'valid',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'env',
        label: 'Variables',
        icon: 'key',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr)',
            heads: ['Name', 'Value', 'Origin'],
            rows: [
              [
                {
                  t: 'SERVICE_URL_GRAFANA',
                  mono: true,
                },
                {
                  t: 'https://grafana.atelier-nord.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'generated',
                  dim: true,
                },
              ],
              [
                {
                  t: 'GF_SECURITY_ADMIN_PASSWORD',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'secret',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
              [
                {
                  t: 'PG_URL',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'linked',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'volumes',
        label: 'Volumes and backups',
        icon: 'device-sd-card',
        head: 'Data',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,0.6fr) minmax(0,1fr)',
            heads: ['Volume', 'Size', 'Backup'],
            rows: [
              [
                {
                  t: 'grafana-data',
                  mono: true,
                },
                '420 MiB',
                {
                  t: 'every night · S3',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'postgres-data',
                  mono: true,
                },
                '1.1 GiB',
                {
                  t: 'every night · S3',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'tasks',
        label: 'Scheduled tasks',
        icon: 'clock',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.8fr)',
            heads: ['Name', 'Command', 'Schedule'],
            rows: [
              [
                'Dashboards export',
                {
                  t: 'grafana-cli export',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: '0 4 * * *',
                  mono: true,
                },
              ],
            ],
            add: 'Add a task',
          },
        ],
      },
      {
        k: 'danger',
        label: 'Danger zone',
        icon: 'alert-triangle',
        head: 'Operations',
        blocks: [
          {
            type: 'danger',
            items: [
              ['Stop service', 'All 3 containers are stopped.', 'Stop'],
              [
                'Delete service',
                'Containers, volumes and domains. Backups are kept for 30 days.',
                'Delete',
              ],
            ],
          },
        ],
      },
    ],
  },
  deploy: {
    label: '15 Deployment',
    title: 'Deployment 4f2c1a9',
    sub: 'api-facturation · production · “Adds PDF export” · triggered by Inès L. via push to main',
    crumbs: ['Atelier Nord', 'Client Lumen', 'production', 'api-facturation', '4f2c1a9'],
    pills: [['live', 'oklch(0.78 0.13 155)'], ['1 min 15 s']],
    actions: [
      ['Roll back to 9c41e07', 'arrow-back-up', 0],
      ['Redeploy', 'refresh', 1],
    ],
    blocks: [
      {
        type: 'stats',
        items: [
          ['git-commit', 'Queued', '0.8 s', 'signed webhook verified'],
          ['hammer', 'Build', '38 s', 'cache 82% · srv-ams-6'],
          ['database', 'Release', '9 s', '3 migrations'],
          ['heartbeat', 'Health check', '14 s', '3/3 healthy', 'oklch(0.78 0.13 155)'],
          ['arrows-exchange', 'Switchover', '12 s', 'previous version drained'],
        ],
      },
      {
        type: 'code',
        title: 'Full log',
        aside: 'Rootless BuildKit',
        mh: '420px',
        lines: [
          {
            p: '10:12:03 ',
            t: 'webhook push lumen/api-facturation@4f2c1a9 · signature ok',
          },
          {
            p: '10:12:03 ',
            t: 'shipkeep.yml validated against schema v1',
          },
          {
            p: '10:12:04 ',
            t: 'BuildImage → srv-ams-6',
          },
          {
            p: '10:12:06 ',
            t: '#4 [deps 2/3] RUN npm ci --omit=dev  CACHED',
          },
          {
            p: '10:12:31 ',
            t: '#7 [build 3/3] RUN npm run build  24.1s',
          },
          {
            p: '10:12:42 ',
            t: 'push registry.internal/api-facturation:4f2c1a9 · 214 MB',
          },
          {
            p: '10:12:51 ',
            t: 'RunReleaseTask npm run migrate · 0042_invoice_pdf_export ok',
          },
          {
            p: '10:12:52 ',
            t: 'placement: srv-par-1, srv-fra-2, srv-ams-3 (spread)',
          },
          {
            p: '10:12:58 ',
            t: 'StartContainer ×3 · health GET /healthz',
            c: '#EDEDEF',
          },
          {
            p: '10:13:06 ',
            t: 'health 3/3 · UpsertRoute factures.lumen.fr',
            c: 'oklch(0.78 0.13 155)',
          },
          {
            p: '10:13:18 ',
            t: 'previous version 9c41e07 drained then stopped · live',
            c: 'oklch(0.78 0.13 155)',
          },
        ],
      },
    ],
  },
  integrations: {
    label: '16 Integrations',
    title: 'Integrations',
    sub: 'Git sources, S3 storage, registries, cloud providers and access tokens shared by the organization.',
    crumbs: ['Atelier Nord', 'Integrations'],
    sections: [
      {
        k: 'git',
        label: 'Git sources',
        icon: 'git-branch',
        blocks: [
          {
            type: 'cards',
            min: '260px',
            items: [
              {
                name: 'GitHub App · lumen',
                logo: 'github',
                sub: '14 allowed repositories',
                badge: 'connected',
                bc: 'oklch(0.78 0.13 155)',
                meta: [
                  ['webhook', 'signed webhooks'],
                  ['git-pull-request', 'previews'],
                ],
              },
              {
                name: 'GitLab · verdi',
                logo: 'gitlab',
                sub: 'gitlab.com · 6 projets',
                badge: 'connected',
                bc: 'oklch(0.78 0.13 155)',
                meta: [['webhook', 'signed webhooks']],
              },
              {
                name: 'Forgejo · internal',
                logo: 'forgejo',
                sub: 'git.atelier-nord.fr · 9 repositories',
                badge: 'token expires in 12 d',
                bc: 'oklch(0.80 0.12 80)',
              },
              {
                name: 'Add a source',
                icon: 'plus',
                sub: 'GitHub, GitLab, Gitea, Forgejo, Bitbucket',
                cta: 'Connect',
              },
            ],
          },
        ],
      },
      {
        k: 's3',
        label: 'S3 storage',
        icon: 'bucket',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            heads: ['Name', 'Endpoint', 'Used by', 'State'],
            rows: [
              [
                {
                  t: 'backups-par',
                  logo: 'scaleway',
                },
                {
                  t: 's3.fr-par.scw.cloud/atelier-nord-backups',
                  mono: true,
                  fg: '#7E7E87',
                },
                '11 resources',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'backups-cold',
                  logo: 'backblaze',
                },
                {
                  t: 's3.eu-central-003.backblazeb2.com',
                  mono: true,
                  fg: '#7E7E87',
                },
                '4 resources',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
            add: 'Add storage',
          },
        ],
      },
      {
        k: 'registries',
        label: 'Registries',
        icon: 'packages',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,0.8fr)',
            heads: ['Registry', 'Account', 'State'],
            rows: [
              [
                {
                  t: 'ghcr.io',
                  logo: 'github',
                },
                'lumen-bot',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'docker.io',
                  logo: 'docker',
                },
                'atelier-nord',
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                {
                  t: 'registry.internal',
                  icon: 'lock',
                },
                {
                  t: 'managed by Shipkeep',
                  dim: true,
                },
                {
                  t: 'ok',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
            ],
            add: 'Add a registry',
          },
        ],
      },
      {
        k: 'cloud',
        label: 'Cloud providers',
        icon: 'cloud',
        blocks: [
          {
            type: 'cards',
            min: '240px',
            items: [
              {
                name: 'Hetzner',
                logo: 'hetzner',
                sub: 'token · atelier-nord project',
                badge: 'connected',
                bc: 'oklch(0.78 0.13 155)',
              },
              {
                name: 'DigitalOcean',
                logo: 'digitalocean',
                sub: 'not connected',
                cta: 'Connect',
              },
              {
                name: 'Vultr',
                logo: 'vultr',
                sub: 'not connected',
                cta: 'Connect',
              },
              {
                name: 'Scaleway',
                logo: 'scaleway',
                sub: 'not connected',
                cta: 'Connect',
              },
            ],
          },
          {
            type: 'note',
            text: 'A connected provider lets you create a server from Shipkeep: the machine boots with the agent and its join token.',
          },
        ],
      },
      {
        k: 'cloudinit',
        label: 'cloud-init scripts',
        icon: 'script',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,1.6fr) minmax(0,0.6fr)',
            heads: ['Name', 'Description', 'Used'],
            rows: [
              ['base-hardening', 'Key-only SSH, fail2ban, unattended-upgrades', '6'],
              ['monitoring-node', 'node_exporter and persistent journald', '2'],
            ],
            add: 'Add a script',
          },
        ],
      },
      {
        k: 'tokens',
        label: 'API tokens',
        icon: 'key',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            heads: ['Name', 'Scope', 'Last used', 'Expires'],
            rows: [
              [
                'ci-github-actions',
                {
                  t: 'deploy:lumen/*',
                  mono: true,
                },
                '12 min ago',
                'in 81 d',
              ],
              [
                'terraform',
                {
                  t: 'read:* · write:servers',
                  mono: true,
                },
                'yesterday',
                'in 23 d',
              ],
              [
                'grafana-datasource',
                {
                  t: 'read:metrics',
                  mono: true,
                },
                '1 min ago',
                {
                  t: 'never',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
            ],
            add: 'Create a token',
          },
          {
            type: 'note',
            tone: 'ours',
            text: 'A token is shown only once. Every use is recorded in the audit log.',
          },
        ],
      },
    ],
  },
  sharedvars: {
    label: '17 Shared variables',
    title: 'Shared variables',
    sub: 'Defined once, referenced everywhere with {{ organization.NAME }}, {{ project.NAME }}, {{ environment.NAME }} or {{ server.NAME }}.',
    crumbs: ['Atelier Nord', 'Shared variables'],
    layout: 'tabs',
    sections: [
      {
        k: 'org',
        label: 'Organization',
        icon: 'building',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,0.7fr) minmax(0,0.7fr)',
            heads: ['Name', 'Value', 'Type', 'Used'],
            rows: [
              [
                {
                  t: 'SENTRY_DSN',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'secret',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
                '12 apps',
              ],
              [
                {
                  t: 'SMTP_HOST',
                  mono: true,
                },
                {
                  t: 'smtp.mailgun.org',
                  mono: true,
                  fg: '#7E7E87',
                },
                'text',
                '8 apps',
              ],
              [
                {
                  t: 'TZ',
                  mono: true,
                },
                {
                  t: 'Europe/Paris',
                  mono: true,
                  fg: '#7E7E87',
                },
                'text',
                'all',
              ],
            ],
            add: 'Add a variable',
          },
        ],
      },
      {
        k: 'project',
        label: 'Project',
        icon: 'folder',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1fr) minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,0.7fr)',
            heads: ['Project', 'Name', 'Value', 'Type'],
            rows: [
              [
                'Client Lumen',
                {
                  t: 'STRIPE_ACCOUNT',
                  mono: true,
                },
                {
                  t: 'acct_1Q…',
                  mono: true,
                  fg: '#7E7E87',
                },
                'text',
              ],
              [
                'Client Lumen',
                {
                  t: 'STRIPE_KEY',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'secret',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
              [
                'Client Verdi',
                {
                  t: 'SHOPIFY_TOKEN',
                  mono: true,
                },
                {
                  t: '••••••••',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'secret',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
            ],
            add: 'Add a variable',
          },
        ],
      },
      {
        k: 'env',
        label: 'Environment',
        icon: 'stack-2',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1.2fr)',
            heads: ['Environment', 'Name', 'Value'],
            rows: [
              [
                'Lumen · production',
                {
                  t: 'APP_URL',
                  mono: true,
                },
                {
                  t: 'https://factures.lumen.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
              [
                'Lumen · staging',
                {
                  t: 'APP_URL',
                  mono: true,
                },
                {
                  t: 'https://staging.factures.lumen.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
              [
                'Lumen · preview',
                {
                  t: 'APP_URL',
                  mono: true,
                },
                {
                  t: 'https://pr-{n}.factures.lumen.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'server',
        label: 'Server',
        icon: 'server-2',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr)',
            heads: ['Server', 'Name', 'Value'],
            rows: [
              [
                {
                  t: 'srv-par-1',
                  mono: true,
                },
                {
                  t: 'REGION',
                  mono: true,
                },
                {
                  t: 'par',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
              [
                {
                  t: 'srv-fra-2',
                  mono: true,
                },
                {
                  t: 'REGION',
                  mono: true,
                },
                {
                  t: 'fra',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
              [
                {
                  t: 'srv-ams-3',
                  mono: true,
                },
                {
                  t: 'REGION',
                  mono: true,
                },
                {
                  t: 'ams',
                  mono: true,
                  fg: '#7E7E87',
                },
              ],
            ],
          },
        ],
      },
    ],
  },
  notifs: {
    label: '18 Notifications',
    title: 'Notifications',
    sub: 'Where and when to notify the team.',
    crumbs: ['Atelier Nord', 'Notifications'],
    sections: [
      {
        k: 'events',
        label: 'Events',
        icon: 'bell',
        head: 'Rules',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.6fr) repeat(4,minmax(0,0.6fr))',
            heads: ['Event', 'Email', 'Slack', 'Discord', 'Webhook'],
            rows: [
              [
                'Deployment succeeded',
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Deployment failed',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Suspect or down server',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Backup failed',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: '—',
                  dim: true,
                },
              ],
              [
                'Certificate expires in < 14 d',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: '—',
                  dim: true,
                },
              ],
              [
                'Metric alert',
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Shipkeep update',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: '—',
                  dim: true,
                },
                {
                  t: '—',
                  dim: true,
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'email',
        label: 'Email',
        icon: 'mail',
        head: 'Channels',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'Recipients',
                v: 'ops@atelier-nord.fr',
              },
              {
                l: 'Sending',
                v: 'Instance SMTP',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'slack',
        label: 'Slack',
        icon: 'brand-slack',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'Webhook',
                v: 'https://hooks.slack.com/services/••••',
              },
              {
                l: 'Channel',
                v: '#prod-alertes',
              },
            ],
          },
        ],
      },
      {
        k: 'discord',
        label: 'Discord',
        icon: 'brand-discord',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'Webhook',
                v: 'https://discord.com/api/webhooks/••••',
              },
            ],
          },
        ],
      },
      {
        k: 'telegram',
        label: 'Telegram',
        icon: 'brand-telegram',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: false,
              },
              {
                l: 'Bot token',
                v: 'not configured',
                mono: false,
              },
              {
                l: 'Chat ID',
                v: '—',
              },
            ],
          },
        ],
      },
      {
        k: 'pushover',
        label: 'Pushover',
        icon: 'device-mobile',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: false,
              },
              {
                l: 'User key',
                v: 'not configured',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'webhook',
        label: 'Webhook',
        icon: 'webhook',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'URL',
                v: 'https://ops.atelier-nord.fr/hooks/shipkeep',
              },
              {
                l: 'Signature',
                v: 'HMAC-SHA256 · X-Shipkeep-Signature header',
              },
            ],
          },
        ],
      },
    ],
  },
  tags: {
    label: '19 Tags',
    title: 'Tags',
    sub: 'Group resources from several projects to filter, deploy or restart them together.',
    crumbs: ['Atelier Nord', 'Tags'],
    actions: [['New tag', 'plus', 1]],
    blocks: [
      {
        type: 'cards',
        min: '240px',
        items: [
          {
            name: 'node',
            icon: 'tag',
            sub: '6 resources',
            meta: [['folder', 'Lumen, Verdi']],
            cta: 'Redeploy all',
          },
          {
            name: 'client-billed',
            icon: 'tag',
            sub: '11 resources',
            meta: [['folder', 'Lumen, Verdi']],
          },
          {
            name: 'critical',
            icon: 'tag',
            sub: '4 resources',
            meta: [['folder', 'Lumen']],
            hl: 1,
          },
          {
            name: 'internal',
            icon: 'tag',
            sub: '5 resources',
            meta: [['folder', 'Internal tools']],
          },
        ],
      },
    ],
  },
  org: {
    label: '20 Organization',
    title: 'Atelier Nord',
    sub: 'Organization that owns the instance · 7 members · 4 projects',
    crumbs: ['Atelier Nord', 'Organization'],
    sections: [
      {
        k: 'general',
        label: 'General',
        icon: 'building',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Name',
                v: 'Atelier Nord',
                mono: false,
              },
              {
                l: 'Identifier',
                v: 'atelier-nord',
              },
              {
                l: 'Description',
                v: 'Web agency · Lyon',
                mono: false,
              },
              {
                l: '2FA required for everyone',
                toggle: true,
              },
            ],
          },
        ],
      },
      {
        k: 'members',
        label: 'Members',
        icon: 'users',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,0.8fr) minmax(0,0.6fr)',
            heads: ['Name', 'Email', 'Role', '2FA'],
            rows: [
              [
                'Samuel M.',
                {
                  t: 'samuel@atelier-nord.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'owner',
                  dot: '#EDEDEF',
                  fg: '#EDEDEF',
                },
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Inès L.',
                {
                  t: 'ines@atelier-nord.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                'admin',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Marc D.',
                {
                  t: 'marc@atelier-nord.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                'member',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Yuki T.',
                {
                  t: 'yuki@atelier-nord.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                'member',
                {
                  t: 'yes',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
              ],
              [
                'Claire (Lumen)',
                {
                  t: 'claire@lumen.fr',
                  mono: true,
                  fg: '#7E7E87',
                },
                {
                  t: 'client',
                  dim: true,
                },
                {
                  t: 'no',
                  dot: 'oklch(0.80 0.12 80)',
                  fg: 'oklch(0.80 0.12 80)',
                },
              ],
            ],
            add: 'Invite',
          },
        ],
      },
      {
        k: 'invites',
        label: 'Invitations',
        icon: 'mail-forward',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.5fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            heads: ['Email', 'Role', 'Expires'],
            rows: [
              [
                {
                  t: 'paul@verdi.shop',
                  mono: true,
                },
                'client',
                'in 6 d',
              ],
              [
                {
                  t: 'lea@atelier-nord.fr',
                  mono: true,
                },
                'member',
                'in 2 d',
              ],
            ],
          },
        ],
      },
      {
        k: 'audit',
        label: 'Audit log',
        icon: 'history',
        blocks: [
          {
            type: 'note',
            text: 'The full log is on the Audit log screen.',
          },
        ],
      },
      {
        k: 'danger',
        label: 'Danger zone',
        icon: 'alert-triangle',
        blocks: [
          {
            type: 'danger',
            items: [
              ['Transfer ownership', 'Another admin becomes the owner.', 'Transfer'],
              ['Delete organization', 'Deletes linked projects, resources and servers.', 'Delete'],
            ],
          },
        ],
      },
    ],
  },
  settings: {
    label: '21 Settings',
    title: 'Instance settings',
    sub: 'cp.atelier-nord.fr · Shipkeep v0.1.0-rc.2 · control plane on srv-cp-1',
    crumbs: ['Instance', 'Settings'],
    sections: [
      {
        k: 'general',
        label: 'General',
        icon: 'settings',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Control plane URL',
                v: 'https://cp.atelier-nord.fr',
              },
              {
                l: 'Instance name',
                v: 'Atelier Nord',
                mono: false,
              },
              {
                l: 'Time zone',
                v: 'Europe/Paris',
              },
              {
                l: 'Open sign-ups',
                toggle: false,
              },
              {
                l: 'Telemetry',
                toggle: false,
                v: 'Never',
              },
            ],
          },
        ],
      },
      {
        k: 'updates',
        label: 'Updates',
        icon: 'refresh',
        blocks: [
          {
            type: 'stats',
            items: [
              ['package', 'Version', 'v0.1.0-rc.2', 'stable channel'],
              ['arrow-up', 'Available', 'v0.1.0', 'published 2 d ago', 'oklch(0.78 0.13 155)'],
            ],
          },
          {
            type: 'fields',
            items: [
              {
                l: 'Channel',
                v: 'stable',
              },
              {
                l: 'Auto update',
                toggle: false,
              },
              {
                l: 'Backup before upgrade',
                toggle: true,
                h: 'Auto rollback on failure',
              },
            ],
          },
        ],
      },
      {
        k: 'backup',
        label: 'Control plane backup',
        icon: 'database-export',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Enabled',
                toggle: true,
              },
              {
                l: 'Schedule',
                v: '0 1 * * *',
              },
              {
                l: 'Destination',
                v: 's3://atelier-nord-backups/cp',
                tag: 'encrypted',
              },
              {
                l: 'Latest',
                v: 'today 01:00 · 84 MiB',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'email',
        label: 'Outgoing email',
        icon: 'mail',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Transport',
                v: 'SMTP',
                mono: false,
              },
              {
                l: 'Host',
                v: 'smtp.mailgun.org:587',
              },
              {
                l: 'Sender',
                v: 'Shipkeep <no-reply@atelier-nord.fr>',
              },
            ],
          },
        ],
      },
      {
        k: 'oauth',
        label: 'External sign-in',
        icon: 'login-2',
        blocks: [
          {
            type: 'cards',
            min: '220px',
            items: [
              {
                name: 'GitHub',
                logo: 'github',
                badge: 'enabled',
                bc: 'oklch(0.78 0.13 155)',
              },
              {
                name: 'GitLab',
                logo: 'gitlab',
                sub: 'disabled',
                cta: 'Configure',
              },
              {
                name: 'Google',
                logo: 'google',
                sub: 'disabled',
                cta: 'Configure',
              },
              {
                name: 'Generic OIDC',
                icon: 'id',
                sub: 'Keycloak, Authentik…',
                cta: 'Configure',
              },
            ],
          },
        ],
      },
      {
        k: 'scan',
        label: 'Image scanning',
        icon: 'bug',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Scan every built image',
                toggle: true,
              },
              {
                l: 'Engine',
                v: 'Trivy',
              },
              {
                l: 'Block above',
                v: 'critical',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'advanced',
        label: 'Advanced',
        icon: 'adjustments',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'WireGuard range',
                v: '10.42.0.0/24',
              },
              {
                l: 'Agent port',
                v: '7443',
              },
              {
                l: 'Lease duration',
                v: '60 s',
              },
              {
                l: 'Log retention',
                v: '30 days',
              },
            ],
          },
        ],
      },
    ],
  },
  profile: {
    label: '22 Profile',
    title: 'Samuel M.',
    sub: 'samuel@atelier-nord.fr · owner of Atelier Nord',
    crumbs: ['Profile'],
    sections: [
      {
        k: 'account',
        label: 'Account',
        icon: 'user',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Name',
                v: 'Samuel Mbabhazi',
                mono: false,
              },
              {
                l: 'Email',
                v: 'samuel@atelier-nord.fr',
              },
              {
                l: 'Language',
                v: 'French',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'security',
        label: 'Security',
        icon: 'shield-lock',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Password',
                v: 'modified 3 months ago',
                mono: false,
              },
              {
                l: 'Two-factor authentication',
                toggle: true,
                v: 'TOTP · enabled',
              },
              {
                l: 'Recovery codes',
                v: '8 of 10 left',
                mono: false,
              },
            ],
          },
        ],
      },
      {
        k: 'sessions',
        label: 'Sessions',
        icon: 'devices',
        blocks: [
          {
            type: 'table',
            cols: 'minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) 90px',
            heads: ['Device', 'Location', 'Last activity', ''],
            rows: [
              [
                'Firefox · Linux',
                'Lyon',
                {
                  t: 'now',
                  dot: 'oklch(0.78 0.13 155)',
                  fg: 'oklch(0.78 0.13 155)',
                },
                {
                  t: 'current',
                  dim: true,
                },
              ],
              [
                'Safari · iPhone',
                'Lyon',
                '2 h ago',
                {
                  t: 'Close',
                  fg: '#FF8A8A',
                },
              ],
              [
                'Shipkeep CLI',
                'Paris',
                'yesterday',
                {
                  t: 'Close',
                  fg: '#FF8A8A',
                },
              ],
            ],
          },
        ],
      },
      {
        k: 'appearance',
        label: 'Appearance',
        icon: 'palette',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                l: 'Theme',
                v: 'Black',
                mono: false,
              },
              {
                l: 'Reduced motion',
                toggle: false,
              },
            ],
          },
        ],
      },
    ],
  },
  vulns: {
    label: '23 Vulnerabilities',
    title: 'Vulnerabilities',
    sub: 'Trivy scan result for all images in service.',
    crumbs: ['Atelier Nord', 'Vulnerabilities'],
    actions: [['Rescan', 'refresh', 0]],
    blocks: [
      {
        type: 'stats',
        items: [
          ['alert-octagon', 'Critical', '0', '', 'oklch(0.78 0.13 155)'],
          ['alert-triangle', 'High', '2', 'in 1 image', 'oklch(0.68 0.17 25)'],
          ['info-triangle', 'Averages', '11', ''],
          ['box', 'Scanned images', '23', '4 h ago'],
        ],
      },
      {
        type: 'table',
        cols: 'minmax(0,1fr) minmax(0,1.3fr) minmax(0,0.7fr) minmax(0,1fr) minmax(0,0.9fr)',
        heads: ['CVE', 'Package', 'Severity', 'Image', 'Fixed in'],
        rows: [
          [
            {
              t: 'CVE-2026-31422',
              mono: true,
            },
            'openssl 3.0.13',
            {
              t: 'high',
              dot: 'oklch(0.68 0.17 25)',
              fg: 'oklch(0.68 0.17 25)',
            },
            {
              t: 'worker-mails:9a0c771',
              mono: true,
              fg: '#7E7E87',
            },
            {
              t: '3.0.15',
              mono: true,
            },
          ],
          [
            {
              t: 'CVE-2026-28810',
              mono: true,
            },
            'libexpat 2.5.0',
            {
              t: 'high',
              dot: 'oklch(0.68 0.17 25)',
              fg: 'oklch(0.68 0.17 25)',
            },
            {
              t: 'worker-mails:9a0c771',
              mono: true,
              fg: '#7E7E87',
            },
            {
              t: '2.6.3',
              mono: true,
            },
          ],
          [
            {
              t: 'CVE-2026-19934',
              mono: true,
            },
            'busybox 1.36',
            {
              t: 'average',
              dot: 'oklch(0.80 0.12 80)',
              fg: 'oklch(0.80 0.12 80)',
            },
            {
              t: 'caddy:2.9-alpine',
              mono: true,
              fg: '#7E7E87',
            },
            {
              t: '1.36.1-r2',
              mono: true,
            },
          ],
        ],
      },
    ],
  },
  onboarding: {
    label: '24 First start',
    title: 'Welcome to Shipkeep',
    sub: 'Four steps, about 10 minutes. You can change everything later.',
    crumbs: ['First start'],
    blocks: [
      {
        type: 'steps',
        items: [
          {
            t: 'Create organization',
            d: 'Atelier Nord · you are the owner',
            icon: 'building',
            state: 'done',
          },
          {
            t: 'Add your first server',
            d: 'Generate a 15-minute token and run one command on the machine.',
            icon: 'server-2',
            state: 'active',
            cta: 'Generate token',
            go: 'servers',
          },
          {
            t: 'Connect a source',
            d: 'GitHub, GitLab, Gitea or a Docker image.',
            icon: 'git-branch',
            cta: 'Connect',
            go: 'integrations',
          },
          {
            t: 'Deploy an application',
            d: 'From a repository with shipkeep.yml, or start from a template.',
            icon: 'rocket',
            cta: 'Choose',
            go: 'new',
          },
        ],
      },
      {
        type: 'code',
        title: 'Command to run on the server',
        lines: [
          {
            t: 'curl -fsSL get.shipkeep.dev/agent | sudo sh -s -- \\',
            c: '#EDEDEF',
          },
          {
            t: '--join cp.atelier-nord.fr:7443 \\',
            c: '#EDEDEF',
          },
          {
            t: '--token skj_7Hc2…Qe9 --ca sha256:9f3a…c41e',
            c: '#EDEDEF',
          },
        ],
      },
    ],
  },
  terminal: {
    label: '25 Terminal',
    title: 'Terminal',
    sub: 'Open a session in a server or a container. It goes through the agent: no SSH port is open.',
    crumbs: ['Atelier Nord', 'Terminal'],
    blocks: [
      {
        type: 'note',
        tone: 'ours',
        text: 'Every session is recorded in the audit log, with the person, the target and the duration.',
      },
      {
        type: 'table',
        title: 'Targets',
        cols: 'minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) 90px',
        heads: ['Target', 'Type', 'Server', ''],
        rows: [
          [
            {
              t: 'srv-par-1',
              icon: 'server-2',
            },
            'Server',
            {
              t: 'srv-par-1',
              mono: true,
            },
            {
              t: 'Open',
              fg: '#EDEDEF',
            },
          ],
          [
            {
              t: 'api-facturation-7f9c',
              logo: 'nodedotjs',
            },
            'Container',
            {
              t: 'srv-par-1',
              mono: true,
            },
            {
              t: 'Open',
              fg: '#EDEDEF',
            },
          ],
          [
            {
              t: 'pg-factures',
              logo: 'postgresql',
            },
            'Container',
            {
              t: 'srv-par-1',
              mono: true,
            },
            {
              t: 'Open',
              fg: '#EDEDEF',
            },
          ],
          [
            {
              t: 'grafana',
              logo: 'grafana',
            },
            'Container',
            {
              t: 'srv-ams-3',
              mono: true,
            },
            {
              t: 'Open',
              fg: '#EDEDEF',
            },
          ],
        ],
      },
      {
        type: 'code',
        title: 'srv-par-1',
        lines: [
          {
            p: '$ ',
            t: 'docker ps --format "{{.Names}}\\t{{.Status}}"',
            c: '#EDEDEF',
          },
          'api-facturation-7f9c   Up 12 minutes (healthy)',
          'site-www-a1e2          Up 26 hours (healthy)',
          'pg-factures            Up 9 days (healthy)',
          'caddy                  Up 9 days',
          {
            p: '$ ',
            t: 'df -h /',
            c: '#EDEDEF',
          },
          '/dev/sda1  320G  212G  108G  66% /',
        ],
      },
    ],
  },
};
