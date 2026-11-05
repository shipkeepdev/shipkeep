import type { IncomingMessage } from 'node:http';

import { acceptsLargeJson } from './body-limits';

const ID = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const ENVIRONMENT = `/api/v1/organizations/${ID}/projects/${ID}/environments/${ID}`;

function request(url: string, method = 'POST', contentType = 'application/json'): IncomingMessage {
  return { url, method, headers: { 'content-type': contentType } } as unknown as IncomingMessage;
}

describe('acceptsLargeJson', () => {
  it('accepts JSON posts to secrets and application writes only', () => {
    for (const path of [
      `${ENVIRONMENT}/secrets`,
      `${ENVIRONMENT}/applications`,
      `${ENVIRONMENT}/applications/${ID}/config`,
      `${ENVIRONMENT}/secrets?x=1`,
    ])
      expect(acceptsLargeJson(request(path))).toBe(true);
    expect(
      acceptsLargeJson(
        request(`${ENVIRONMENT}/secrets`, 'POST', 'application/json; charset=utf-8'),
      ),
    ).toBe(true);
  });

  it('keeps every other request on the default limit', () => {
    for (const candidate of [
      request(`${ENVIRONMENT}/secrets`, 'PUT'),
      request(`${ENVIRONMENT}/secrets`, 'POST', 'text/plain'),
      request(`${ENVIRONMENT}/secrets`, 'POST', 'application/jsonp'),
      request(`${ENVIRONMENT}/secrets/TOKEN/remove`),
      request(`${ENVIRONMENT}/settings`),
      request('/api/v1/auth/register'),
      request(`${ENVIRONMENT}/secrets/../../../../auth/register`),
      request(`/api/v1/organizations/x/projects/${ID}/environments/${ID}/secrets`),
      request(`/prefix${ENVIRONMENT}/secrets`),
    ])
      expect(acceptsLargeJson(candidate)).toBe(false);
    expect(
      acceptsLargeJson({
        url: `${ENVIRONMENT}/secrets`,
        method: 'POST',
        headers: {},
      } as unknown as IncomingMessage),
    ).toBe(false);
  });
});
