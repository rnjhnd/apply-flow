import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { healthResponseSchema } from '@applyflow/contracts';
import type { Env } from './config/env.js';

export function createApp(env: Env) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/v1/health/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(healthResponseSchema.parse({
      status: 'ok', service: 'applyflow-api'
    }));
  });

  const notFound: express.RequestHandler = (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
  };

  // Unknown API routes must never receive the frontend HTML fallback.
  app.use('/api', notFound);

  if (env.NODE_ENV === 'production') {
    const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    const indexFile = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
    if (!existsSync(indexFile)) {
      throw new Error('Frontend build is missing. Run npm run build before starting production.');
    }
    app.use('/assets', express.static(`${webRoot}/assets`, {
      index: false, maxAge: '1y', immutable: true
    }), notFound);
    app.use(express.static(webRoot, { index: false, maxAge: 0 }));
    app.use((req, res, next) => {
      const isNavigation = (req.method === 'GET' || req.method === 'HEAD')
        && req.get('accept')?.includes('text/html') && !extname(req.path);
      if (!isNavigation) return next();
      res.set('Cache-Control', 'no-cache').sendFile(indexFile);
    });
  }

  app.use(notFound);
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ code: 'BODY_TOO_LARGE', message: 'Request body exceeds the 16 KB limit.' });
      return;
    }
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({ code: 'UNSUPPORTED_ENCODING', message: 'Request encoding is not supported.' });
      return;
    }
    console.error('Unhandled request error');
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  };
  app.use(errorHandler);
  return app;
}
