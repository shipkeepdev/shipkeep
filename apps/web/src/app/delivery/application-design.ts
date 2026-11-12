import { type Block, type Section } from '../dashboard/screen-model';

/**
 * The application screen of the design: its configuration menu, and sample content for the parts
 * the control plane does not serve yet (scheduled tasks, approvals, webhooks, logs, terminal and
 * metrics). Pages built from these samples carry the "Preview" label.
 */
export type AppSection = Omit<Section, 'blocks'>;

export const APP_SECTIONS: readonly AppSection[] = [
  {
    k: 'general',
    label: 'General',
    icon: 'adjustments',
    head: 'Application',
  },
  {
    k: 'yml',
    label: 'shipkeep.yml',
    icon: 'file-code',
    ours: 1,
  },
  {
    k: 'source',
    label: 'Source',
    icon: 'git-branch',
  },
  {
    k: 'domains',
    label: 'Domains',
    icon: 'world',
  },
  {
    k: 'env',
    label: 'Variables and secrets',
    icon: 'key',
  },
  {
    k: 'storage',
    label: 'Persistent storage',
    icon: 'database',
  },
  {
    k: 'placement',
    label: 'Placement',
    icon: 'server-2',
    head: 'Run',
    ours: 1,
  },
  {
    k: 'health',
    label: 'Health check',
    icon: 'heartbeat',
  },
  {
    k: 'limits',
    label: 'Resource limits',
    icon: 'cpu',
  },
  {
    k: 'tasks',
    label: 'Scheduled tasks',
    icon: 'clock',
  },
  {
    k: 'previews',
    label: 'Previews',
    icon: 'git-pull-request',
  },
  {
    k: 'rollback',
    label: 'Rollback',
    icon: 'arrow-back-up',
    head: 'Operations',
  },
  {
    k: 'approvals',
    label: 'Approvals',
    icon: 'shield-check',
    ours: 1,
  },
  {
    k: 'webhooks',
    label: 'Webhooks',
    icon: 'webhook',
  },
  {
    k: 'actions',
    label: 'Agent actions',
    icon: 'list-check',
    ours: 1,
  },
  {
    k: 'danger',
    label: 'Danger zone',
    icon: 'alert-triangle',
  },
];

export interface SectionCopy {
  readonly title: string;
  readonly desc: string;
  readonly ours?: number;
  readonly save?: string;
  readonly blocks: readonly Block[];
}

export const APP_SAMPLES: Readonly<
  Record<'tasks' | 'approvals' | 'webhooks' | 'danger', SectionCopy>
> = {
  tasks: {
    title: 'Scheduled tasks',
    desc: 'Commands run in an app container on a cron schedule.',
    blocks: [
      {
        type: 'table',
        cols: 'minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,0.8fr) minmax(0,0.9fr)',
        heads: ['Name', 'Command', 'Schedule', 'Last run'],
        rows: [
          [
            {
              t: 'Payment reminders',
            },
            {
              t: 'npm run dunning',
              mono: true,
              fg: '#8B8B93',
            },
            {
              t: '0 8 * * *',
              mono: true,
            },
            {
              t: 'ok · 08:00',
              fg: 'oklch(0.78 0.13 155)',
              dot: 'oklch(0.78 0.13 155)',
            },
          ],
          [
            {
              t: 'PDF cleanup',
            },
            {
              t: 'npm run purge:pdf',
              mono: true,
              fg: '#8B8B93',
            },
            {
              t: '0 3 * * 0',
              mono: true,
            },
            {
              t: 'ok · dim.',
              fg: 'oklch(0.78 0.13 155)',
              dot: 'oklch(0.78 0.13 155)',
            },
          ],
          [
            {
              t: 'Accounting export',
            },
            {
              t: 'npm run export',
              mono: true,
              fg: '#8B8B93',
            },
            {
              t: '0 6 1 * *',
              mono: true,
            },
            {
              t: 'failed · Nov 1',
              fg: 'oklch(0.68 0.17 25)',
              dot: 'oklch(0.68 0.17 25)',
            },
          ],
        ],
        add: 'Add a task',
      },
    ],
  },
  approvals: {
    title: 'Approvals',
    desc: 'Production is protected: a deployment or a secret change requires admin approval.',
    ours: 1,
    save: 'Save',
    blocks: [
      {
        type: 'fields',
        items: [
          {
            l: 'Protected environment',
            toggle: true,
            v: 'Enabled',
          },
          {
            l: 'Approvers',
            v: 'Inès L., Alex M.',
            mono: false,
          },
          {
            l: 'Required approvals',
            v: '1',
            mono: true,
          },
          {
            l: 'Allow self-approval',
            toggle: false,
            v: 'Disabled',
          },
        ],
      },
      {
        type: 'note',
        text: 'Every approval is written to the audit log in the same transaction as the action.',
      },
    ],
  },
  webhooks: {
    title: 'Webhooks',
    desc: 'Trigger a deployment from your CI, or get notified.',
    save: 'Save',
    blocks: [
      {
        type: 'fields',
        items: [
          {
            l: 'Deployment URL',
            h: 'HMAC-signed POST',
            v: 'https://cp.atelier-nord.example/hooks/d/••••',
            mono: true,
          },
          {
            l: 'Outgoing events',
            v: 'deploy.succeeded, deploy.failed',
            mono: true,
          },
          {
            l: 'Notifications',
            v: 'Slack #prod · e-mail',
            mono: false,
          },
        ],
      },
    ],
  },
  danger: {
    title: 'Danger zone',
    desc: 'Irreversible actions. Each one requires confirmation, and admin approval in production.',
    blocks: [
      {
        type: 'danger',
        items: [
          [
            'Enter maintenance',
            'Caddy serves a maintenance page; containers keep running.',
            'Enable',
          ],
          ['Stop application', 'All replicas are stopped. Volumes are kept.', 'Stop'],
          [
            'Delete application',
            'Deletes containers, images and domains. Backups are kept for 30 days.',
            'Delete',
          ],
        ],
      },
    ],
  },
};

export const SAMPLE_LOGS: readonly { t: string; node: string; lvl: string; msg: string }[] = [
  {
    t: '10:22:41',
    node: 'srv-par-1',
    lvl: 'INF',
    msg: 'GET /invoices/8812 200 · 38 ms',
  },
  {
    t: '10:22:41',
    node: 'srv-fra-2',
    lvl: 'INF',
    msg: 'POST /invoices 201 · 112 ms',
  },
  {
    t: '10:22:40',
    node: 'srv-ams-3',
    lvl: 'INF',
    msg: 'GET /healthz 200 · 2 ms',
  },
  {
    t: '10:22:39',
    node: 'srv-par-1',
    lvl: 'WRN',
    msg: 'pg pool 18/20 · wait 40 ms',
  },
  {
    t: '10:22:38',
    node: 'srv-fra-2',
    lvl: 'INF',
    msg: 'GET /invoices?status=due 200 · 64 ms',
  },
  {
    t: '10:22:36',
    node: 'srv-par-1',
    lvl: 'ERR',
    msg: 'POST /invoices/8790/pdf 502 · upstream timeout',
  },
  {
    t: '10:22:35',
    node: 'srv-ams-3',
    lvl: 'INF',
    msg: 'Stripe webhook invoice.paid processed',
  },
  {
    t: '10:22:33',
    node: 'srv-fra-2',
    lvl: 'INF',
    msg: 'GET /invoices/8811 200 · 31 ms',
  },
  {
    t: '10:22:31',
    node: 'srv-par-1',
    lvl: 'INF',
    msg: 'PDF 8789 generated · 1.2 MB',
  },
  {
    t: '10:22:30',
    node: 'srv-ams-3',
    lvl: 'INF',
    msg: 'GET /healthz 200 · 2 ms',
  },
  {
    t: '10:22:28',
    node: 'srv-fra-2',
    lvl: 'WRN',
    msg: 'retry SMTP 1/3 · reminder-8781',
  },
  {
    t: '10:22:27',
    node: 'srv-par-1',
    lvl: 'INF',
    msg: 'GET /invoices 200 · 45 ms',
  },
];

export const SAMPLE_TERMINAL: readonly { t: string; c: string }[] = [
  {
    t: '$ node -v',
    c: '#EDEDEF',
  },
  {
    t: 'v22.11.0',
    c: '#8B8B93',
  },
  {
    t: '$ npm run migrate:status',
    c: '#EDEDEF',
  },
  {
    t: '✓ 0042_invoice_pdf_export   applied',
    c: '#8B8B93',
  },
  {
    t: '✓ 0041_vat_rounding         applied',
    c: '#8B8B93',
  },
  {
    t: '$ ls storage/pdf | wc -l',
    c: '#EDEDEF',
  },
  {
    t: '8789',
    c: '#8B8B93',
  },
];

export const SAMPLE_CHARTS: readonly {
  label: string;
  v: string;
  bars: readonly { h: string; hot: boolean; last: boolean }[];
}[] = [
  {
    label: 'CPU · 3 replicas',
    v: '34 %',
    bars: [
      { h: '41.03677462019741%', hot: false, last: false },
      { h: '44.98934007603763%', hot: false, last: false },
      { h: '40.21241009548975%', hot: false, last: false },
      { h: '28.374703753897627%', hot: false, last: false },
      { h: '26.38852755067078%', hot: false, last: false },
      { h: '38.920062382698205%', hot: false, last: false },
      { h: '44.84227509083661%', hot: false, last: false },
      { h: '42.08636639300383%', hot: false, last: false },
      { h: '31.615054485343933%', hot: false, last: false },
      { h: '22.91373012126232%', hot: false, last: false },
      { h: '36.424664967969726%', hot: false, last: false },
      { h: '44.19799180078716%', hot: false, last: false },
      { h: '43.51826391699433%', hot: false, last: false },
      { h: '34.62292982229404%', hot: false, last: false },
      { h: '20.619385636333945%', hot: false, last: false },
      { h: '33.600527772234244%', hot: false, last: false },
      { h: '43.06938554032016%', hot: false, last: false },
      { h: '44.479443228782934%', hot: false, last: false },
      { h: '37.338127119428094%', hot: false, last: false },
      { h: '24.140104386207735%', hot: false, last: false },
      { h: '30.50417592066602%', hot: false, last: false },
      { h: '41.4790453714124%', hot: false, last: false },
      { h: '44.95066631790904%', hot: false, last: false },
      { h: '39.706301684382936%', hot: false, last: false },
      { h: '27.5779589186426%', hot: false, last: false },
      { h: '27.197582916626633%', hot: false, last: false },
      { h: '39.45880196335746%', hot: false, last: false },
      { h: '44.9225016510399%', hot: false, last: false },
      { h: '41.68005448713953%', hot: false, last: false },
      { h: '30.86414055179742%', hot: false, last: true },
    ],
  },
  {
    label: 'Memory',
    v: '612 MiB',
    bars: [
      { h: '58.63946140238522%', hot: false, last: false },
      { h: '52.732520577321964%', hot: false, last: false },
      { h: '45.8756121514137%', hot: false, last: false },
      { h: '54.177868364140785%', hot: false, last: false },
      { h: '59.27403110834274%', hot: false, last: false },
      { h: '59.38386411994708%', hot: false, last: false },
      { h: '54.468999568084826%', hot: false, last: false },
      { h: '46.24634104226244%', hot: false, last: false },
      { h: '52.41170026707912%', hot: false, last: false },
      { h: '58.4806214371744%', hot: false, last: false },
      { h: '59.84037369935073%', hot: false, last: false },
      { h: '56.0159564681117%', hot: false, last: false },
      { h: '48.343348711503715%', hot: false, last: false },
      { h: '50.497186938778924%', hot: false, last: false },
      { h: '57.417397036284804%', hot: false, last: false },
      { h: '59.99985309826055%', hot: false, last: false },
      { h: '57.34242892453064%', hot: false, last: false },
      { h: '50.37343923355243%', hot: false, last: false },
      { h: '48.47264737652306%', hot: false, last: false },
      { h: '56.10563834928673%', hot: false, last: false },
      { h: '59.859110335423054%', hot: false, last: false },
      { h: '58.421867582107566%', hot: false, last: false },
      { h: '52.295980332807%', hot: false, last: false },
      { h: '46.3786027534152%', hot: false, last: false },
      { h: '54.57160023521921%', hot: false, last: false },
      { h: '59.42096237819335%', hot: false, last: false },
      { h: '59.23266746877186%', hot: false, last: false },
      { h: '54.072492336094264%', hot: false, last: false },
      { h: '45.74303461317551%', hot: false, last: false },
      { h: '52.84598647736544%', hot: false, last: true },
    ],
  },
  {
    label: 'p95 latency',
    v: '412 ms',
    bars: [
      { h: '29.233600241796015%', hot: false, last: false },
      { h: '38.27561329884557%', hot: false, last: false },
      { h: '51.147273172407644%', hot: false, last: false },
      { h: '54.88493826507522%', hot: false, last: false },
      { h: '48.18293462667961%', hot: false, last: false },
      { h: '33.382464945967776%', hot: false, last: false },
      { h: '34.34624090540134%', hot: false, last: false },
      { h: '48.8100359154746%', hot: false, last: false },
      { h: '54.95630036123815%', hot: false, last: false },
      { h: '50.63796724264844%', hot: false, last: false },
      { h: '37.3635545572527%', hot: false, last: false },
      { h: '30.229803436689387%', hot: false, last: false },
      { h: '45.99624062780627%', hot: false, last: false },
      { h: '54.428086901994746%', hot: false, last: false },
      { h: '52.579855769940266%', hot: false, last: false },
      { h: '41.09718754001305%', hot: false, last: false },
      { h: '26.0086914166341%', hot: false, last: false },
      { h: '42.76220544121669%', hot: false, last: false },
      { h: '53.310870083323124%', hot: false, last: false },
      { h: '53.969733296478324%', hot: false, last: false },
      { h: '44.50863520471351%', hot: false, last: false },
      { h: '28.23260956898332%', hot: false, last: false },
      { h: '39.17265959195399%', hot: false, last: false },
      { h: '81.62701100744509%', hot: true, last: false },
      { h: '84.779781414119%', hot: true, last: false },
      { h: '77.52961740315028%', hot: true, last: false },
      { h: '32.40920985209863%', hot: false, last: false },
      { h: '35.299447864596864%', hot: false, last: false },
      { h: '49.410212125213164%', hot: false, last: false },
      { h: '54.99378700428008%', hot: false, last: true },
    ],
  },
  {
    label: 'Requests / min',
    v: '5 920',
    bars: [
      { h: '65.27209981231712%', hot: false, last: false },
      { h: '74.74764014533858%', hot: false, last: false },
      { h: '70.33818622880612%', hot: false, last: false },
      { h: '53.5840871765503%', hot: false, last: false },
      { h: '39.66196819401975%', hot: false, last: false },
      { h: '61.27946394875156%', hot: false, last: false },
      { h: '73.71678688125945%', hot: false, last: false },
      { h: '72.62922226719093%', hot: false, last: false },
      { h: '58.39668771567047%', hot: false, last: false },
      { h: '35.99101701813438%', hot: false, last: false },
      { h: '56.76084443557479%', hot: false, last: false },
      { h: '71.91101686451226%', hot: false, last: false },
      { h: '74.1671091660527%', hot: false, last: false },
      { h: '62.741003391084895%', hot: false, last: false },
      { h: '41.62416701793238%', hot: false, last: false },
      { h: '51.80668147306564%', hot: false, last: false },
      { h: '69.36647259425983%', hot: false, last: false },
      { h: '74.92106610865447%', hot: false, last: false },
      { h: '66.5300826950127%', hot: false, last: false },
      { h: '47.12473426982809%', hot: false, last: false },
      { h: '46.516132666602616%', hot: false, last: false },
      { h: '66.13408314137195%', hot: false, last: false },
      { h: '74.87600264166385%', hot: false, last: false },
      { h: '69.68808717942332%', hot: false, last: false },
      { h: '52.382624882875874%', hot: false, last: false },
      { h: '40.99508838651809%', hot: false, last: false },
      { h: '62.27854480272542%', hot: false, last: false },
      { h: '74.03282071067902%', hot: false, last: false },
      { h: '72.15180936308963%', hot: false, last: false },
      { h: '57.29260214070646%', hot: false, last: true },
    ],
  },
];
