import { type Block, type Section } from '../dashboard/screen-model';

/**
 * The application screen of the design: its configuration menu, and sample content for the parts
 * the control plane does not serve yet (scheduled tasks, approvals and webhooks).
 * Pages built from these samples carry the "Preview" label.
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

export const APP_SAMPLES: Readonly<Record<'tasks' | 'approvals' | 'webhooks', SectionCopy>> = {
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
};
