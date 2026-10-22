import {
  authenticatedResponseSchema, authErrorResponseSchema, csrfResponseSchema, csrfTokenSchema,
  loginRequestSchema, meResponseSchema, registerRequestSchema,
  type AuthErrorResponse, type LoginRequest, type RegisterRequest
} from '@applyflow/contracts';

export type FailureKind = 'http' | 'validation' | 'network' | 'protocol' | 'coordination' | 'stale' | 'busy' | 'cooldown';
export class AuthFailure extends Error {
  constructor(readonly kind: FailureKind, readonly status = 0,
    readonly code: AuthErrorResponse['code'] | null = null, readonly retryAt: number | null = null,
    readonly fields: readonly ('email' | 'password')[] = []) {
    // Never retain arbitrary server messages, Zod input, responses, or underlying exceptions.
    super('Authentication request could not be completed.');
    this.name = 'AuthFailure';
  }
}

export function retryAfter(value: string | null, now: number): number {
  const seconds = value !== null && /^\d+$/.test(value) ? Number(value) : NaN;
  const date = value !== null && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
    ? Date.parse(value) : NaN;
  const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : date;
  return Number.isSafeInteger(deadline) && deadline >= now ? deadline : now + 60_000;
}

export function validateCredentials(kind: 'login' | 'register', input: unknown): LoginRequest | RegisterRequest {
  const parsed = (kind === 'login' ? loginRequestSchema : registerRequestSchema).safeParse(input);
  if (!parsed.success) {
    const fields = (['email', 'password'] as const).filter((field) => parsed.error.issues.some((issue) => issue.path[0] === field));
    throw new AuthFailure('validation', 400, 'INVALID_REQUEST', null, fields);
  }
  return parsed.data;
}

export function createAuthApi(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  async function request<T>(endpoint: 'csrf' | 'me' | 'register' | 'login' | 'logout', schema: { parse(value: unknown): T },
    input?: { body: unknown; csrfToken: string }): Promise<T> {
    const headers: Record<string, string> = { 'X-ApplyFlow-Request': '1' };
    if (input) {
      if (!csrfTokenSchema.safeParse(input.csrfToken).success) throw new AuthFailure('validation', 400);
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = input.csrfToken;
    }
    let response: Response;
    try {
      response = await fetcher(`/api/v1/auth/${endpoint}`, {
        method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers,
        ...(input ? { body: JSON.stringify(input.body) } : {}),
        // Only /me cannot deliver cookies. Never abort bootstrap or authentication mutations.
        ...(endpoint === 'me' ? { signal: AbortSignal.timeout(8000) } : {})
      });
    } catch { throw new AuthFailure('network'); }
    if (endpoint === 'logout' && response.status === 204) return undefined as T;
    let body: unknown;
    try {
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error();
      body = await response.json();
    } catch { throw new AuthFailure('protocol', response.status, null,
      response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : null); }
    if (!response.ok) {
      const error = authErrorResponseSchema.safeParse(body);
      if (!error.success) throw new AuthFailure('protocol', response.status,
        null, response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : null);
      const fields = (['email', 'password'] as const).filter((field) => error.data.fieldErrors?.[field]);
      throw new AuthFailure('http', response.status, error.data.code,
        response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : null, fields);
    }
    const expectedStatus = endpoint === 'register' ? 201 : 200;
    if (response.status !== expectedStatus || endpoint === 'logout') throw new AuthFailure('protocol', response.status);
    try { return schema.parse(body); } catch { throw new AuthFailure('protocol', response.status); }
  }
  return {
    csrf: () => request('csrf', csrfResponseSchema),
    me: () => request('me', meResponseSchema),
    login: (input: LoginRequest, csrfToken: string) => request('login', authenticatedResponseSchema,
      { body: validateCredentials('login', input), csrfToken }),
    register: (input: RegisterRequest, csrfToken: string) => request('register', authenticatedResponseSchema,
      { body: validateCredentials('register', input), csrfToken }),
    logout: (csrfToken: string) => request<void>('logout', { parse() { throw new Error(); } }, { body: {}, csrfToken })
  };
}
export type AuthApi = ReturnType<typeof createAuthApi>;
