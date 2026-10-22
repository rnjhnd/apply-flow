import { Router, type Request } from 'express';
import type { AuthConfig } from '../../config/auth.js';
import { createAuthAdmission } from '../auth/admission.js';
import { readSessionCookie } from '../auth/cookies.js';
import { requireJsonRequest, trustedAuthRequest } from '../auth/request.js';
import { ApplicationHttpError } from './http-error.js';
import type { ApplicationService } from './service.js';

export function createApplicationsHttp(config: AuthConfig, service: ApplicationService) {
  const beforeJson = Router();
  const router = Router();
  beforeJson.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  beforeJson.use(createAuthAdmission().requestLimit, trustedAuthRequest(config));
  beforeJson.all('/', (request, response, next) => {
    if (!['GET', 'POST'].includes(request.method)) {
      response.set('Allow', 'GET, POST');
      return next(new ApplicationHttpError(405, 'INVALID_REQUEST', 'Use GET or POST for applications.'));
    }
    if (request.method === 'POST') {
      if (request.url.includes('?')) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Create does not accept query parameters.'));
      return requireJsonRequest(request, response, next);
    }
    next();
  });
  function proof(request: Request) {
    let token;
    try { token = readSessionCookie(config.nodeEnv, request.get('cookie')); }
    catch { throw new ApplicationHttpError(400, 'INVALID_COOKIE', 'Ambiguous session cookie.'); }
    if (!token) throw new ApplicationHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
    return { token, csrfToken: request.get('X-CSRF-Token') };
  }
  router.post('/', async (request, response) => { response.status(201).json(await service.create(request.body, proof(request))); });
  router.get('/', async (request, response) => { response.json(await service.list(request.query, proof(request))); });
  return { beforeJson, router };
}
