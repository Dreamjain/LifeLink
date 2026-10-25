import { ApiError } from '../src/api/api-error';
import { request, setAuthFailureListener } from '../src/api/client';
import { config } from '../src/config/env';

interface FakeResponseInput {
  status?: number;
  body?: unknown;
  rawBody?: string;
}

const fakeResponse = ({ status = 200, body, rawBody }: FakeResponseInput = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async (): Promise<string> => rawBody ?? (body === undefined ? '' : JSON.stringify(body)),
});

const fetchMock = jest.fn();

const lastCall = (): [string, RequestInit] => {
  const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;

  if (call === undefined) {
    throw new Error('fetch was never called.');
  }

  return call;
};

const headersOf = (init: RequestInit): Record<string, string> =>
  init.headers as Record<string, string>;

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  setAuthFailureListener(null);
});

describe('config.apiBaseUrl', () => {
  it('derives the backend URL from the Expo dev server host', () => {
    // The Expo host is mocked as 192.168.1.42:8081; the backend listens on :3000 of the same
    // machine, which is what makes a physical phone on the same LAN work with no configuration.
    expect(config.apiBaseUrl).toBe('http://192.168.1.42:3000/api/v1');
    expect(config.apiBaseUrlIsExplicit).toBe(false);
  });
});

describe('api client request', () => {
  it('sends the method, JSON body and base URL', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ body: { ok: true } }));

    const result = await request<{ ok: boolean }>('/auth/login', {
      method: 'POST',
      body: { phone: '+15550001111' },
    });

    const [url, init] = lastCall();

    expect(url).toBe('http://192.168.1.42:3000/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ phone: '+15550001111' }));
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(result).toEqual({ ok: true });
  });

  it('attaches a bearer token and an idempotency key when given', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 201, body: {} }));

    await request('/patients/me/emergencies', {
      method: 'POST',
      body: {},
      token: 'token-abc',
      idempotencyKey: 'sos-key-1',
    });

    const headers = headersOf(lastCall()[1]);

    expect(headers.authorization).toBe('Bearer token-abc');
    expect(headers['idempotency-key']).toBe('sos-key-1');
  });

  it('omits the authorization and content-type headers when there is no token or body', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ body: {} }));

    await request('/auth/me');

    const headers = headersOf(lastCall()[1]);

    expect(headers.authorization).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
    expect(headers['x-correlation-id']).toMatch(/^mp-/);
  });

  it('gives every request its own correlation id', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ body: {} }));

    await request('/auth/me');
    await request('/auth/me');

    const first = headersOf((fetchMock.mock.calls[0] as [string, RequestInit])[1]);
    const second = headersOf((fetchMock.mock.calls[1] as [string, RequestInit])[1]);

    expect(first['x-correlation-id']).not.toBe(second['x-correlation-id']);
  });

  it('unwraps the backend error envelope into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed.',
            details: { issues: [{ path: 'password', message: 'Password is too short.' }] },
            correlationId: 'backend-correlation-id',
          },
        },
      }),
    );

    await expect(request('/auth/register', { method: 'POST', body: {} })).rejects.toThrow(ApiError);

    try {
      await request('/auth/register', { method: 'POST', body: {} });
      throw new Error('The request should have rejected.');
    } catch (caught) {
      const error = caught as ApiError;

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.status).toBe(400);
      expect(error.correlationId).toBe('backend-correlation-id');
      expect(error.issues).toEqual([{ path: 'password', message: 'Password is too short.' }]);
      expect(error.displayMessage).toBe('Password is too short.');
    }
  });

  it('falls back to a generic error when the body is not the expected envelope', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 404, rawBody: '<!DOCTYPE html><p>Cannot GET /nope</p>' }),
    );

    try {
      await request('/nope');
      throw new Error('The request should have rejected.');
    } catch (caught) {
      const error = caught as ApiError;

      // The backend has no JSON 404 handler yet, so an unmatched path really does return HTML.
      expect(error.code).toBe('UNEXPECTED_ERROR');
      expect(error.status).toBe(404);
      expect(error.message).toContain('404');
    }
  });

  it('reports an unreachable backend as a network failure naming the base URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    try {
      await request('/auth/me');
      throw new Error('The request should have rejected.');
    } catch (caught) {
      const error = caught as ApiError;

      expect(error.isNetworkFailure).toBe(true);
      expect(error.status).toBe(0);
      expect(error.message).toContain('http://192.168.1.42:3000/api/v1');
    }
  });

  it('notifies the auth-failure listener when the token itself is rejected', async () => {
    const listener = jest.fn();

    setAuthFailureListener(listener);
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 401,
        body: { error: { code: 'TOKEN_EXPIRED', message: 'The token has expired.' } },
      }),
    );

    await expect(request('/auth/me', { token: 'stale' })).rejects.toThrow(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports INACTIVE_ACCOUNT separately from invalid-token 401 failures', async () => {
    const listener = jest.fn();

    setAuthFailureListener(listener);
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 403,
        body: { error: { code: 'INACTIVE_ACCOUNT', message: 'This account is not active.' } },
      }),
    );

    try {
      await request('/auth/me', { token: 'pending-patient-token' });
      throw new Error('The request should have rejected.');
    } catch (caught) {
      const error = caught as ApiError;

      expect(error.status).toBe(403);
      expect(error.isAuthFailure).toBe(false);
      expect(error.isInactiveAccount).toBe(true);
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ code: 'INACTIVE_ACCOUNT' });
  });
});
