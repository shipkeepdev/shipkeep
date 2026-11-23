import type { Deployment } from './delivery-api';

/**
 * What a deployment does: deploy a release, stop the application, or put it in or take it out of
 * maintenance (ADR 0025). The last three run the release that serves and start nothing.
 */
export type DeploymentKind = 'deploy' | 'stop' | 'enter' | 'leave';

export function deploymentKind(
  deployment: Pick<Deployment, 'stop'> & { readonly maintenance?: Deployment['maintenance'] },
): DeploymentKind {
  if (deployment.stop) return 'stop';
  return deployment.maintenance ?? 'deploy';
}

/** Its name, with the release it ran in `{release}`. */
export const KIND_TITLE: Readonly<Record<DeploymentKind, string>> = {
  deploy: 'Deployment {release}',
  stop: 'Stop of {release}',
  enter: 'Maintenance of {release}',
  leave: 'End of maintenance of {release}',
};

/** What started it, in place of a deployment's trigger. */
export const KIND_CAUSE: Readonly<Partial<Record<DeploymentKind, string>>> = {
  stop: 'stop',
  enter: 'maintenance',
  leave: 'end of maintenance',
};

/** Whether it ran a version of its own, which a rollback can go back to. */
export function ranAVersion(deployment: Pick<Deployment, 'stop' | 'maintenance'>): boolean {
  return deploymentKind(deployment) === 'deploy';
}

/**
 * Whether the application is in maintenance: the deployment that serves, its latest success,
 * entered it (ADR 0025). Deployments come newest first.
 */
export function inMaintenance(deployments: readonly Deployment[]): boolean {
  return (
    deployments.find((deployment) => deployment.state === 'succeeded')?.maintenance === 'enter'
  );
}
