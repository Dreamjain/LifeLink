/**
 * The backend's single error envelope (backend/src/common/middleware/error-handler.middleware.ts):
 *
 *   { error: { code, message, details?, correlationId } }
 *
 * Every failure the app shows a patient comes through this class, so screens never have to know
 * whether a problem was HTTP, JSON or network shaped.
 */
export interface ApiErrorIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;
  readonly issues: ApiErrorIssue[];

  constructor(options: {
    code: string;
    message: string;
    status: number;
    correlationId?: string | null;
    issues?: ApiErrorIssue[];
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.correlationId = options.correlationId ?? null;
    this.issues = options.issues ?? [];
  }

  /** The token is gone or no longer valid: the session must be cleared. */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 &&
      ['MISSING_TOKEN', 'MALFORMED_TOKEN', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(this.code)
    );
  }

  /** The request never reached the backend. The most common cause is a wrong base URL. */
  get isNetworkFailure(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  /**
   * A message fit to show a patient. Validation issues are flattened because the backend reports
   * them per field and a single line is all a small screen has room for.
   */
  get displayMessage(): string {
    if (this.issues.length > 0) {
      return this.issues.map((issue) => issue.message).join(' ');
    }

    return this.message;
  }
}
