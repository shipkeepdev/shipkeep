import { createShipkeepClient, isProblemDetails, PROBLEM_MEDIA_TYPE } from './client.js';

function jsonResponse(body: unknown, status = 200, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

describe('createShipkeepClient', () => {
  it('calls typed paths against the base URL with a bearer token', async () => {
    let captured: Request | undefined;
    const client = createShipkeepClient({
      baseUrl: 'https://cp.example.com',
      apiToken: 'sk_test_fake_token',
      fetch: (input: Request) => {
        captured = input;
        return Promise.resolve(jsonResponse({ status: 'ok', version: '0.1.0' }));
      },
    });

    const { data, error } = await client.GET('/api/v1/health');

    expect(error).toBeUndefined();
    expect(data).toEqual({ status: 'ok', version: '0.1.0' });
    if (!captured) throw new Error('fetch was not called');
    expect(captured.url).toBe('https://cp.example.com/api/v1/health');
    expect(captured.headers.get('authorization')).toBe('Bearer sk_test_fake_token');
    expect(captured.credentials).toBe('include');
  });

  it('surfaces problem details as the error branch', async () => {
    const problem = {
      type: 'https://shipkeep.dev/problems/service_unavailable',
      title: 'Service Unavailable',
      status: 503,
      code: 'service_unavailable',
    };
    const client = createShipkeepClient({
      baseUrl: 'https://cp.example.com',
      fetch: () => Promise.resolve(jsonResponse(problem, 503, PROBLEM_MEDIA_TYPE)),
    });

    const { data, error, response } = await client.GET('/api/v1/ready');
    const body: unknown = error;

    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
    expect(isProblemDetails(body)).toBe(true);
    if (isProblemDetails(body)) expect(body.code).toBe('service_unavailable');
  });
});

describe('isProblemDetails', () => {
  it('accepts well-formed problems and rejects the rest', () => {
    expect(isProblemDetails({ type: 'x', title: 't', status: 404, code: 'not_found' })).toBe(true);
    expect(isProblemDetails({ status: 404 })).toBe(false);
    expect(isProblemDetails(null)).toBe(false);
    expect(isProblemDetails('nope')).toBe(false);
  });
});
