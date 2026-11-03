import { Router, type Request } from 'express';
import { applicationIdSchema } from '@applyflow/contracts';
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
  beforeJson.all('/:id', (request, response, next) => {
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) {
      response.set('Allow', 'GET, PUT, DELETE');
      return next(new ApplicationHttpError(405, 'INVALID_REQUEST', 'Use GET, PUT or DELETE for an application.'));
    }
    if (!applicationIdSchema.safeParse(request.params.id).success) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application ID.'));
    if (request.url.includes('?')) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Application detail and mutations do not accept query parameters.'));
    if (request.method === 'PUT' || request.method === 'DELETE') return requireJsonRequest(request, response, next);
    next();
  });
  for (const operation of ['archive', 'restore'] as const) {
    beforeJson.all(`/:id/${operation}`, (request, response, next) => {
      if (request.method !== 'POST') {
        response.set('Allow', 'POST');
        return next(new ApplicationHttpError(405, 'INVALID_REQUEST', 'Use POST for this lifecycle operation.'));
      }
      if (!applicationIdSchema.safeParse(request.params.id).success) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application ID.'));
      if (request.url.includes('?')) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Lifecycle operations do not accept query parameters.'));
      return requireJsonRequest(request, response, next);
    });
    router.post(`/:id/${operation}`, async (request, response) => {
      response.json(await service[operation](request.params.id, request.body, proof(request)));
    });
  }
  beforeJson.all('/:id/history', (request, response, next) => {
    if (request.method !== 'GET') {
      response.set('Allow', 'GET');
      return next(new ApplicationHttpError(405, 'INVALID_REQUEST', 'Use GET for application history.'));
    }
    if (!applicationIdSchema.safeParse(request.params.id).success) return next(new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application ID.'));
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
  router.get('/:id', async (request, response) => { response.json(await service.get(request.params.id, proof(request))); });
  router.put('/:id', async (request, response) => { response.json(await service.update(request.params.id, request.body, proof(request))); });
  router.delete('/:id', async (request, response) => { response.json(await service.delete(request.params.id, request.body, proof(request))); });
  router.get('/:id/history', async (request, response) => { response.json(await service.history(request.params.id, request.query, proof(request))); });
  return { beforeJson, router };
}
