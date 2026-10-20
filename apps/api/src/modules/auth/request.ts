import type { RequestHandler } from 'express';
import { loginRequestSchema, registerRequestSchema } from '@applyflow/contracts';
import type { AuthConfig } from '../../config/auth.js';
import { AuthHttpError } from './http-error.js';

export function trustedAuthRequest(config: AuthConfig): RequestHandler {
  return (request, _response, next) => {
    const rejected = () => new AuthHttpError(403, 'REQUEST_REJECTED', 'Authentication request rejected.');
    if (request.get('X-ApplyFlow-Request') !== '1') return next(rejected());
    const site = request.get('Sec-Fetch-Site');
    if (site !== undefined && site !== 'same-origin') return next(rejected());
    const origin = request.get('Origin');
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if ((origin !== undefined && origin !== config.appOrigin) || (!safe && origin === undefined)) return next(rejected());
    if (safe && (request.get('transfer-encoding') !== undefined || Number(request.get('content-length') ?? '0') !== 0)) {
      return next(new AuthHttpError(400, 'INVALID_REQUEST', 'Authentication read requests must not contain a body.'));
    }
    next();
  };
}

export const requireJsonRequest: RequestHandler = (request, _response, next) => {
  if (request.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return next(new AuthHttpError(415, 'INVALID_REQUEST', 'Authentication requests require application/json.'));
  }
  next();
};

// Validation primitive only: no register/login routes are mounted in this stage.
export function validateCredentials(kind: 'login' | 'registration'): RequestHandler {
  return (request, response, next) => {
    const parsed = (kind === 'login' ? loginRequestSchema : registerRequestSchema).safeParse(request.body);
    if (!parsed.success) {
      return next(new AuthHttpError(400, 'INVALID_REQUEST', 'Invalid authentication fields.'));
    }
    response.locals.credentials = parsed.data;
    next();
  };
}
