import type { Resources } from '../gen/shipkeep-config.js';

/**
 * What `resources` means for a limit an application leaves out (SPEC 2.2): one CPU, 512 MiB. The
 * control plane enforces and reserves these values and the UI shows them, so they are written
 * once, here, in the same notation as `shipkeep.yml`.
 */
export const DEFAULT_RESOURCES = {
  cpu: '1',
  memory: '512Mi',
} as const satisfies Required<Resources>;
