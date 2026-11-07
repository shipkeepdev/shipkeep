import { type View } from './screen-model';

/** Where each design view lives, relative to `/orgs/:organizationId`. */
export const VIEW_PATHS: Readonly<Partial<Record<string, readonly string[]>>> = {
  overview: [],
  app: ['applications'],
  new: ['new'],
  previews: ['previews'],
  servers: ['servers'],
  server: ['servers', 'sample'],
  data: ['databases'],
  db: ['databases', 'sample'],
  service: ['services', 'sample'],
  deploy: ['deployments', 'sample'],
  obs: ['observability'],
  audit: ['audit'],
  access: ['members'],
  integrations: ['integrations'],
  sharedvars: ['shared-variables'],
  terminal: ['terminal'],
  vulns: ['vulnerabilities'],
  projects: ['projects'],
  project: ['projects'],
  env: ['projects'],
  org: ['organization'],
  notifs: ['notifications'],
  tags: ['tags'],
  settings: ['settings'],
  profile: ['profile'],
  onboarding: ['onboarding'],
};

export function viewCommands(organizationId: string, view: View | undefined): string[] | null {
  if (!view) return null;
  const path = VIEW_PATHS[view];
  return path ? ['/orgs', organizationId, ...path] : null;
}
