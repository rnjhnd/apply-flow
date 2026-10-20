import { Router, type Request, type RequestHandler } from 'express';
import { logoutRequestSchema, type LoginRequest, type RegisterRequest } from '@applyflow/contracts';
import type { AuthConfig } from '../../config/auth.js';
import type { BootstrapSessions } from './csrf.js';
import type { AuthenticationService, SessionProof } from './authentication.js';
import type { createAuthAdmission } from './admission.js';
import { clientAddress } from './admission.js';
import { clearSessionCookie, createSessionCookie, readSessionCookie } from './cookies.js';
import { AuthHttpError } from './http-error.js';
import { requireJsonRequest, validateCredentials } from './request.js';
import { matchesCsrfToken } from './tokens.js';

type Options = { config: AuthConfig; sessions: BootstrapSessions; authentication: AuthenticationService;
  admission: ReturnType<typeof createAuthAdmission>; now: () => Date };

export function createAuthenticationHttp(options: Options) {
  const { config, authentication, admission } = options;
  const beforeJson = Router();
  const router = Router();
  const registrationEnabled: RequestHandler = (_request, _response, next) => {
    if (config.nodeEnv === 'production' || !config.allowLocalRegistration) {
      return next(new AuthHttpError(404, 'NOT_FOUND', 'The requested resource was not found.'));
    }
    next();
  };
  const method = (allowed: string): RequestHandler => (request, response, next) => {
    if (request.method !== allowed) {
      response.set('Allow', allowed);
      return next(new AuthHttpError(405, 'INVALID_REQUEST', `Use ${allowed} for this authentication endpoint.`));
    }
    if (request.url.includes('?')) return next(new AuthHttpError(400, 'INVALID_REQUEST', 'Authentication endpoints do not accept query parameters.'));
    next();
  };
  beforeJson.all('/register', registrationEnabled, method('POST'), requireJsonRequest);
  beforeJson.all('/login', method('POST'), requireJsonRequest);
  beforeJson.all('/logout', method('POST'), requireJsonRequest);
  beforeJson.all('/me', method('GET'));

  async function session(request: Request) {
    let token;
    try { token = readSessionCookie(config.nodeEnv, request.get('cookie')); }
    catch { throw new AuthHttpError(400, 'INVALID_COOKIE', 'Ambiguous session cookie.'); }
    if (!token) throw new AuthHttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    let existing;
    try { existing = await options.sessions.findValid(token); }
    catch { throw new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.', 1); }
    if (!existing) throw new AuthHttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    return { token, existing };
  }
  async function proof(request: Request, kind: 'anonymous' | 'authenticated'): Promise<SessionProof> {
    const { token, existing } = await session(request);
    // Logout's contract is 401 for anonymous sessions, independent of CSRF header presence.
    if (kind === 'authenticated' && existing.userId === null) {
      throw new AuthHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
    }
    const supplied = request.get('X-CSRF-Token');
    if (!matchesCsrfToken(existing.csrfToken, supplied)) {
      throw new AuthHttpError(403, 'REQUEST_REJECTED', 'Authentication request rejected.');
    }
    if (kind === 'anonymous' && existing.userId !== null) {
      throw new AuthHttpError(409, 'ALREADY_AUTHENTICATED', 'Log out before authenticating another session.');
    }
    // matchesCsrfToken has already checked format and type.
    return { token, csrfToken: supplied! };
  }
  router.post('/register', validateCredentials('registration'), async (request, response) => {
    const verified = await proof(request, 'anonymous');
    admission.admitRegistration(clientAddress(request));
    const result = await authentication.register(response.locals.credentials as RegisterRequest, verified);
    response.set('Set-Cookie', createSessionCookie(config.nodeEnv, result.token, result.expiresAt, options.now()))
      .status(201).json(result.body);
  });
  router.post('/login', validateCredentials('login'), async (request, response) => {
    const verified = await proof(request, 'anonymous');
    const input = response.locals.credentials as LoginRequest;
    admission.admitLogin(clientAddress(request), input.email);
    const result = await authentication.login(input, verified);
    response.set('Set-Cookie', createSessionCookie(config.nodeEnv, result.token, result.expiresAt, options.now())).json(result.body);
  });
  router.get('/me', async (request, response) => {
    const { token, existing } = await session(request);
    if (existing.userId === null) throw new AuthHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
    response.json(await authentication.me(token));
  });
  router.post('/logout', async (request, response) => {
    if (!logoutRequestSchema.safeParse(request.body).success) throw new AuthHttpError(400, 'INVALID_REQUEST', 'Logout accepts an empty JSON object.');
    const verified = await proof(request, 'authenticated');
    await authentication.logout(verified);
    // Error responses never clear cookies: a stale concurrent response must not erase a newly rotated cookie.
    response.set('Set-Cookie', clearSessionCookie(config.nodeEnv)).status(204).end();
  });
  return { beforeJson, router };
}
