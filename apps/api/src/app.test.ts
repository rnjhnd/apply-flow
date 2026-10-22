import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { parseAuthConfig } from './config/auth.js';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: vi.fn() }));

function fixture(mode: 'test' | 'development' | 'production' = 'test', serveFrontend?: true) {
  vi.mocked(existsSync).mockReturnValue(true);
  const staticFiles = vi.spyOn(express, 'static').mockImplementation(() => (_req, _res, next) => next());
  const sendFile = vi.spyOn(express.response, 'sendFile').mockImplementation(function (this: express.Response) {
    this.type('html').send('<!doctype html><title>Compiled frontend fixture</title>'); return this;
  });
  const sessions = { findValid: vi.fn().mockResolvedValue(null), createAnonymous: vi.fn() };
  const options = serveFrontend ? { serveFrontend } : {};
  const app = createApp(parseEnv({ NODE_ENV: mode }), { config: parseAuthConfig({ NODE_ENV: 'test' }), sessions }, options);
  return { app, staticFiles, sendFile, sessions };
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(existsSync).mockReset(); });

describe('fixed-path compiled frontend serving (filesystem and authentication mocked)', () => {
  it.each(['test', 'development'] as const)('keeps %s defaults API-only', async (mode) => {
    const { app, staticFiles } = fixture(mode);
    await request(app).get('/login').set('Accept', 'text/html').expect(404).expect('Content-Type', /json/);
    expect(staticFiles).not.toHaveBeenCalled(); expect(existsSync).not.toHaveBeenCalled();
  });
  it.each([['production', undefined], ['test', true]] as const)('serves the fixed frontend for %s opt-in=%s', async (mode, optIn) => {
    const { app, staticFiles, sendFile, sessions } = fixture(mode, optIn);
    const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    const index = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));
    expect(staticFiles.mock.calls).toEqual([
      [`${root}/assets`, { index: false, maxAge: '1y', immutable: true }],
      [root, { index: false, maxAge: 0 }]
    ]);
    await request(app).get('/app').set('Accept', 'text/html').expect(200).expect('Cache-Control', 'no-cache');
    expect(sendFile).toHaveBeenCalledWith(index);
    await request(app).head('/login').set('Accept', 'text/html').expect(200);
    expect(sessions.findValid).not.toHaveBeenCalled(); expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('preserves API JSON 404 and health precedence, asset misses, and non-navigation behavior', async () => {
    const { app, sendFile } = fixture('test', true);
    for (const path of ['/api/v1/missing', '/assets/missing', '/missing.js']) {
      await request(app).get(path).set('Accept', 'text/html').expect(404).expect('Content-Type', /json/);
    }
    await request(app).get('/app').set('Accept', 'application/json').expect(404);
    await request(app).post('/app').set('Accept', 'text/html').expect(404);
    await request(app).get('/api/v1/health/live').expect(200, { status: 'ok', service: 'applyflow-api' });
    expect(sendFile).not.toHaveBeenCalled();
  });
  it('refuses development opt-in without altering its normal startup', () => {
    expect(() => fixture('development', true)).toThrow('restricted to test composition');
  });
  it('fails closed if the fixed compiled index is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const sessions = { findValid: vi.fn(), createAnonymous: vi.fn() };
    expect(() => createApp(parseEnv({ NODE_ENV: 'test' }), {
      config: parseAuthConfig({ NODE_ENV: 'test' }), sessions
    }, { serveFrontend: true })).toThrow('Frontend build is missing');
  });
});
