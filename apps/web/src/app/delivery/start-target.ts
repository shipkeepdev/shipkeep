import type { Deployment } from './delivery-api';

/**
 * After a stop, the deployment to roll back to in order to start the application again: the stop
 * itself, which names the release it stopped. Rolling back to it deploys that release again
 * (SPEC 5.1, issue #256). Deployments come newest first; the stop is the latest success, so it is
 * always among the deployments a page loads, however long the history. Null unless the latest
 * success is a stop.
 */
export function startTarget(deployments: readonly Deployment[]): Deployment | null {
  const latest = deployments.find((deployment) => deployment.state === 'succeeded');
  return latest?.stop === true ? latest : null;
}
