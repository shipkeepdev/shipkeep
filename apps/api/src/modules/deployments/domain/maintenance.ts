import { ConflictError, type MaintenanceChange } from '@shipkeep/domain';

import type { DeploymentRecord, Release, ReleaseDraft } from './release';

/**
 * Entering or leaving maintenance is a deployment of the release that runs, with a plan that
 * only switches its routes (ADR 0025). Like a stop, it needs no secret and no image.
 */
export function maintenanceDraft(running: Release, change: MaintenanceChange): ReleaseDraft {
  return {
    image: running.image,
    plan: { build: false, release: false, maintenance: change },
    secrets: [],
  };
}

/**
 * An application is in maintenance when the deployment that serves, its last that succeeded,
 * entered it. A stop that succeeded after it serves nothing, and ends it.
 */
export function inMaintenance(serving: DeploymentRecord | undefined): boolean {
  return serving?.plan.maintenance === 'enter';
}

/** Agents released before the maintenance page (ADR 0025): they refuse a route without upstream. */
const AGENTS_BEFORE_MAINTENANCE_PAGE: ReadonlySet<unknown> = new Set([
  '0.1.0-alpha.1',
  '0.1.0-alpha.2',
  '0.1.0-alpha.3',
]);

/** Whether an agent of this version serves the maintenance page. */
export function servesMaintenancePage(agentVersion: unknown): boolean {
  return !AGENTS_BEFORE_MAINTENANCE_PAGE.has(agentVersion);
}

export function applicationInMaintenance(): ConflictError {
  return new ConflictError(
    'application_in_maintenance',
    'The application is in maintenance: leave maintenance before deploying it.',
  );
}

export function maintenanceAlreadyOn(): ConflictError {
  return new ConflictError('maintenance_already_on', 'The application is already in maintenance.');
}

export function maintenanceNotOn(): ConflictError {
  return new ConflictError('maintenance_not_on', 'The application is not in maintenance.');
}

export function maintenanceWithoutReplica(): ConflictError {
  return new ConflictError(
    'application_not_running',
    'The application has no running replica to put in maintenance.',
  );
}

export function maintenanceWithoutDomain(): ConflictError {
  return new ConflictError(
    'application_without_domain',
    'The application has no domain: there is no route to show the maintenance page on.',
  );
}

/** Servers, by name, whose agent would refuse the maintenance page: they need a newer agent. */
export function agentsWithoutMaintenancePage(servers: readonly string[]): ConflictError {
  return new ConflictError(
    'agent_outdated',
    'Update the agent on the servers that run this application: their version cannot serve the maintenance page.',
    { servers: [...servers].sort() },
  );
}
