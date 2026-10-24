import { config } from '../config/env';
import { ApiError, type ApiErrorIssue } from './api-error';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Bearer token. Omitted for register and login. */
  token?: string | null;
  /** Sent as Idempotency-Key. Required by POST /patients/me/emergencies. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Invoked whenever the backend rejects the token, so the session can be cleared exactly once. */
type AuthFailureListener = () => void;

let authFailureListener: AuthFailureListener | null = null;

export const setAuthFailureListener = (listener: AuthFailureListener | null): void => {
  authFailureListener = listener;
};

const newCorrelationId = (): string => {
  // A correlation id only has to be unique enough to find one request in the backend's logs;
  // it is never a security boundary, so Math.random is sufficient and needs no native module.
  const random = Math.random().toString(36).slice(2, 10);

  return `mp-${Date.now().toString(36)}-${random}`;
};

const parseIssues = (details: unknown): ApiErrorIssue[] => {
  if (typeof details !== 'object' || details === null || !('issues' in details)) {
    return [];
  }

  const { issues } = details as { issues?: unknown };

  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null) {
      return [];
    }

    const { path, message } = issue as { path?: unknown; message?: unknown };

    return typeof message === 'string'
      ? [{ path: typeof path === 'string' ? path : '', message }]
      : [];
  });
};

/**
 * One request against the LifeLink backend.
 *
 * Everything the app needs on every call lives here and nowhere else: the base URL, the bearer
 * header, a correlation id, JSON encoding, and the translation of the backend's error envelope
 * into an `ApiError`. A 401 that means the token is finished also notifies the session layer, so
 * a stale token logs the patient out once instead of failing screen by screen.
 */
export const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const correlationId = newCorrelationId();
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = { 'x-correlation-id': correlationId };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  let response: Response;

  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    // A dropped connection, a wrong base URL, or a backend that is not running. The message names
    // the URL because a misconfigured host is by far the most common cause during development.
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: `Could not reach the LifeLink server at ${config.apiBaseUrl}. Check your connection.`,
      status: 0,
      correlationId,
      issues: [],
    });
  }

  const rawBody = await response.text();
  let parsedBody: unknown = null;

  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    const envelope =
      typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
        ? (
            parsedBody as {
              error: {
                code?: unknown;
                message?: unknown;
                details?: unknown;
                correlationId?: unknown;
              };
            }
          ).error
        : null;

    const error = new ApiError({
      code: typeof envelope?.code === 'string' ? envelope.code : 'UNEXPECTED_ERROR',
      message:
        typeof envelope?.message === 'string'
          ? envelope.message
          : `The server responded with ${response.status}.`,
      status: response.status,
      correlationId:
        typeof envelope?.correlationId === 'string' ? envelope.correlationId : correlationId,
      issues: parseIssues(envelope?.details),
    });

    if (error.isAuthFailure) {
      authFailureListener?.();
    }

    throw error;
  }

  return parsedBody as T;
};
