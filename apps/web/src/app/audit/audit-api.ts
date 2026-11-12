import { Injectable } from '@angular/core';

import { type Schema, WorkspaceApi } from '../workspace/workspace-api';

export type AuditEvent = Schema<'AuditEventDto'>;
export interface AuditQuery {
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly actorId?: string;
  /** ISO 8601, inclusive. */
  readonly from?: string;
  /** ISO 8601, exclusive. */
  readonly to?: string;
}
export interface AuditExport {
  readonly text: string;
  /** More events matched than one export holds; the oldest ones are left out. */
  readonly truncated: boolean;
}

/** The organization's audit log (SPEC 4): a filtered page, or everything as JSON Lines. */
@Injectable({ providedIn: 'root' })
export class AuditApi extends WorkspaceApi {
  page(
    organizationId: string,
    query: AuditQuery,
    cursor?: string,
  ): Promise<Schema<'AuditEventPageDto'>> {
    return this.required(() =>
      this.client.GET('/api/v1/organizations/{organizationId}/audit-events', {
        params: {
          path: { organizationId },
          query: { ...query, ...(cursor ? { cursor } : {}), limit: 50 },
        },
      }),
    );
  }
  export(organizationId: string, query: AuditQuery): Promise<AuditExport> {
    return this.required(async () => {
      const { data, response } = await this.client.GET(
        '/api/v1/organizations/{organizationId}/audit-events/export',
        { params: { path: { organizationId }, query }, parseAs: 'text' },
      );
      return {
        response,
        ...(data === undefined
          ? {}
          : {
              data: {
                text: data,
                truncated: response.headers.get('x-shipkeep-truncated') === 'true',
              },
            }),
      };
    });
  }
}
