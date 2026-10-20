import { Router, type RequestHandler } from 'express';
import { csrfResponseSchema } from '@applyflow/contracts';
import type { AuthConfig } from '../../config/auth.js';
import type { createSessionService } from './sessions.js';
import { createSessionCookie, readSessionCookie } from './cookies.js';
import { createAuthAdmission, clientAddress } from './admission.js';
import { trustedAuthRequest } from './request.js';
import { AuthHttpError } from './http-error.js';
import type { AuthenticationService } from './authentication.js';
import { createAuthenticationHttp } from './routes.js';

export type BootstrapSessions = Pick<ReturnType<typeof createSessionService>, 'findValid' | 'createAnonymous'>;
export type AuthHttpOptions = { config: AuthConfig; sessions: BootstrapSessions; now?: () => Date;
  admission?: ReturnType<typeof createAuthAdmission>; authentication?: AuthenticationService };

export function createAuthHttp(options: AuthHttpOptions) {
  const clock = options.now ?? (() => new Date());
  const admission = options.admission ?? createAuthAdmission({ now: clock });
  const noStore: RequestHandler = (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); };
  const router = Router();
  router.all('/csrf', (request, response, next) => {
    if (request.method !== 'GET') {
      response.set('Allow', 'GET');
      return next(new AuthHttpError(405, 'INVALID_REQUEST', 'Use GET for CSRF bootstrap.'));
    }
    if (request.url.includes('?')) return next(new AuthHttpError(400, 'INVALID_REQUEST', 'CSRF bootstrap does not accept query parameters.'));
    next();
  });
  router.get('/csrf', async (request, response) => {
    let token: string | null;
    try { token = readSessionCookie(options.config.nodeEnv, request.get('cookie')); }
    catch { throw new AuthHttpError(400, 'INVALID_COOKIE', 'Ambiguous session cookie.'); }
    let existing;
    try { existing = token ? await options.sessions.findValid(token) : null; }
    catch { throw new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Authentication storage is unavailable.', 1); }
    if (existing) {
      response.json(csrfResponseSchema.parse({ csrfToken: existing.csrfToken }));
      return;
    }
    admission.reserveAnonymous(clientAddress(request));
    let created;
    try { created = await options.sessions.createAnonymous(); }
    catch { throw new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Authentication storage is unavailable.', 1); }
    // The runtime service uses a standalone guarded client: create resolves after commit.
    const cookie = createSessionCookie(options.config.nodeEnv, created.token, created.session.expiresAt, clock());
    const body = csrfResponseSchema.parse({ csrfToken: created.session.csrfToken });
    response.set('Set-Cookie', cookie).json(body);
  });
  // Bootstrap-only composition remains useful for isolated tests; runtime always supplies the authentication service.
  const authentication = options.authentication ? createAuthenticationHttp({ config: options.config, sessions: options.sessions,
    authentication: options.authentication, admission, now: clock }) : undefined;
  if (authentication) router.use(authentication.router);
  return { admission: [noStore, admission.requestLimit, trustedAuthRequest(options.config),
    ...(authentication ? [authentication.beforeJson] : [])], router };
}
