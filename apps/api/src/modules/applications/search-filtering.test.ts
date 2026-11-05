import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { applicationStatusSchema } from '@applyflow/contracts';
import { PrismaClient, type Prisma, type JobApplication, type Session } from '../../generated/prisma/client.ts';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';
import { createApplicationService, type ApplicationTransaction } from './service.js';
import { decodeApplicationCursor, encodeApplicationCursor } from './pagination.js';

const userId = 'fe97bd36-272f-4da9-bba5-61eea12ccf3e';
const id = 'c4974360-a70c-4a29-8b41-df95d15d7270';
const now = new Date('2026-10-22T01:00:00.000Z');
const proof = { token: 'a'.repeat(64), csrfToken: 'b'.repeat(64) };
const headers = { Origin: 'http://127.0.0.1:5173', 'X-ApplyFlow-Request': '1', Cookie: `applyflow_session=${proof.token}` };
const boundary = { OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: id } }] };
const searchGroup = (contains: string) => ({ OR: [
  { company: { contains, mode: 'insensitive' } }, { jobTitle: { contains, mode: 'insensitive' } }
] });
function fixture() {
  const session: Session = { id, userId, tokenHash: 'c'.repeat(64), csrfToken: proof.csrfToken,
    createdAt: now, lastSeenAt: now, expiresAt: new Date('2026-10-23T01:00:00.000Z') };
  const raw = vi.fn().mockResolvedValue([session]);
  const findMany = vi.fn<(args: Prisma.JobApplicationFindManyArgs) => Promise<JobApplication[]>>().mockResolvedValue([]);
  const transaction = { $queryRaw: raw, jobApplication: { findMany }, session: {} } as unknown as ApplicationTransaction;
  const host = { $transaction: vi.fn(async <T>(work: (tx: ApplicationTransaction) => Promise<T>) => work(transaction)) };
  const service = createApplicationService({
    $transaction: <T>(work: (tx: ApplicationTransaction) => Promise<T>) => host.$transaction(work) as Promise<T>
  }, { now: () => now, timeZone: 'Asia/Manila' });
  const app = createApp(parseEnv({ NODE_ENV: 'test' }), {
    config: parseAuthConfig({ NODE_ENV: 'test' }), sessions: { findValid: vi.fn(), createAnonymous: vi.fn() }
  }, { applications: service });
  return { service, app, host, raw, findMany, session };
}

describe('search/filter list service and HTTP (offline database ports)', () => {
  it.each(applicationStatusSchema.options)('conjoins %s, text, owner, archived view and both cursor alternatives', async status => {
    const f = fixture();
    await f.service.list({ q: '  EnGiNeer  ', status, view: 'archived', limit: '2', cursor: encodeApplicationCursor({ id, createdAt: now }) }, proof);
    expect(f.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId, archivedAt: { not: null }, status, AND: [searchGroup('EnGiNeer')], ...boundary },
      select: expect.objectContaining({ id: true, version: true, archivedAt: true }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 3
    });
    // These are predicate-construction assertions, not a JS imitation of ILIKE.
    expect(f.raw).toHaveBeenCalledTimes(2);
  });
  it('leaves default, blank-search and status-only queries free of a text predicate', async () => {
    const f = fixture();
    for (const query of [{}, { q: '' }, { q: ' \t\n ' }]) {
      await f.service.list(query, proof);
      expect(f.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId, archivedAt: null }, take: 21 }));
    }
    await f.service.list({ status: 'SAVED' }, proof);
    expect(f.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId, archivedAt: null, status: 'SAVED' } }));
  });
  it('projects only the bounded database page and uses its last returned matching row as cursor', async () => {
    const f = fixture();
    const row: JobApplication = { id, userId, version: 3, archivedAt: null, company: 'Acme', jobTitle: 'Engineer',
      status: 'SAVED', applicationDate: null, notes: null, location: null, jobUrl: null, createdAt: now, updatedAt: now };
    f.findMany.mockResolvedValue([row, { ...row, id: userId }]);
    const result = await f.service.list({ q: 'Acme', status: 'SAVED', limit: 1 }, proof);
    expect(f.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { userId, status: 'SAVED', AND: [searchGroup('Acme')] }, take: 2 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id, version: 3, archivedAt: null });
    expect(result.items[0]).not.toHaveProperty('userId');
    expect(decodeApplicationCursor(result.nextCursor!)).toEqual({ id, createdAt: now });
    f.findMany.mockResolvedValue([]);
    expect(await f.service.list({ q: 'No matches', limit: 1 }, proof)).toEqual({ items: [], nextCursor: null });
  });
  it('treats any valid cursor as a boundary without an anchor lookup, retaining owner and lifecycle predicates', async () => {
    const f = fixture();
    await f.service.list({ q: 'Acme', cursor: encodeApplicationCursor({ id, createdAt: now }) }, proof);
    expect(f.findMany).toHaveBeenCalledOnce();
    expect(f.findMany.mock.calls[0]?.[0].where).toEqual({ userId, archivedAt: null, AND: [searchGroup('Acme')], ...boundary });
    expect(f.raw.mock.calls[0]?.[0].join(' ')).toContain('FOR UPDATE');
    expect(f.raw).toHaveBeenCalledTimes(2); // Session lock/refresh only, no application anchor read.
  });
  it.each(['missing', 'anonymous', 'expired', 'refresh rejected'] as const)('blocks filtered data access for %s sessions', async kind => {
    const f = fixture();
    if (kind === 'missing') f.raw.mockResolvedValue([]);
    if (kind === 'anonymous') f.session.userId = null;
    if (kind === 'expired') f.session.expiresAt = now;
    if (kind === 'refresh rejected') f.raw.mockResolvedValueOnce([f.session]).mockResolvedValueOnce([]);
    await expect(f.service.list({ q: 'Acme', status: 'APPLIED' }, proof)).rejects.toMatchObject({ status: 401 });
    expect(f.findMany).not.toHaveBeenCalled();
  });
  it.each([{ q: '\u0000' }, { q: '\ud800' }, { q: ['Acme', 'Other'] }, { q: {} }, { q: 'x'.repeat(201) },
    { status: ['SAVED', 'APPLIED'] }, { status: 'saved' }, { userId }, { q: 'Acme', cursor: 'abc' }])(
    'rejects malformed queries before transaction construction %#', async query => {
      const f = fixture();
      await expect(f.service.list(query, proof)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
      expect(f.host.$transaction).not.toHaveBeenCalled();
    });
  it.each(['q=A&q=B', 'q=A&q=A', 'status=SAVED&status=APPLIED', 'status=SAVED&status=SAVED',
    'q%5B%5D=Acme', 'q%5Bcontains%5D=Acme', 'status=ALL', 'q=%00', 'q=' + 'x'.repeat(201), 'ownerId=other']) (
    'rejects ambiguous/invalid HTTP query %s without database-port access', async query => {
      const f = fixture();
      const response = await request(f.app).get('/api/applications?' + query).set(headers).expect(400);
      expect(response.body).toEqual({ code: 'INVALID_REQUEST', message: 'Invalid application list query.' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(f.host.$transaction).not.toHaveBeenCalled();
    });
  it('accepts encoded literal search and an optional status through HTTP without requiring mutation CSRF', async () => {
    const f = fixture(); const q = '  50%_\\O\'Reilly "jobs"  ';
    await request(f.app).get('/api/applications').query({ q, status: 'OFFER', view: 'archived' }).set(headers)
      .expect(200, { items: [], nextCursor: null });
    expect(f.findMany.mock.calls[0]?.[0].where).toEqual({ userId, archivedAt: { not: null }, status: 'OFFER',
      AND: [searchGroup('50\\%\\_\\\\O\'Reilly "jobs"')] });
  });
  it('retains request admission and missing-cookie rejection on filtered HTTP reads', async () => {
    const f = fixture();
    await request(f.app).get('/api/applications?q=Acme').set(headers).unset('Cookie').expect(401);
    await request(f.app).get('/api/applications?q=Acme').set(headers).unset('X-ApplyFlow-Request').expect(403);
    await request(f.app).get('/api/applications?q=Acme').set(headers).set('Origin', 'https://evil.invalid').expect(403);
    expect(f.host.$transaction).not.toHaveBeenCalled();
  });
  it('sanitizes query failure without retrying the transaction or returning unfiltered data', async () => {
    const f = fixture(); f.findMany.mockRejectedValue(new Error('private query details'));
    const response = await request(f.app).get('/api/applications?q=Acme').set(headers).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Applications are temporarily unavailable.' });
    expect(f.findMany).toHaveBeenCalledOnce(); expect(f.host.$transaction).toHaveBeenCalledOnce();
  });
});

describe('installed Prisma PostgreSQL compiler (offline SQL capture, no database driver)', () => {
  it.each([
    ['%', '\\%'], ['_', '\\_'], ['\\', '\\\\'], ["'", "'"], ['"', '"'],
    ['50%_\\O\'Reilly "--', '50\\%\\_\\\\O\'Reilly "--']
  ])('binds literal %j as an escaped ILIKE substring without SQL interpolation', async (q, escaped) => {
    const queries: Array<{ sql: string; args: unknown[] }> = [];
    const dispose = vi.fn(async () => {});
    // This factory has no pg driver, URL, socket or environment access. It returns
    // empty rows and captures the SQL produced by the real installed compiler.
    const adapter: Prisma.PrismaClientOptionsWithAdapter['adapter'] = {
      provider: 'postgres', adapterName: 'offline-sql-capture',
      connect: async () => ({
        provider: 'postgres', adapterName: 'offline-sql-capture', dispose,
        queryRaw: async query => { queries.push({ sql: query.sql, args: query.args }); return { columnNames: [], columnTypes: [], rows: [] }; },
        executeRaw: async () => { throw new Error('Offline capture forbids writes'); },
        executeScript: async () => { throw new Error('Offline capture forbids scripts'); },
        startTransaction: async () => { throw new Error('Offline capture forbids driver transactions'); }
      })
    };
    const client = new PrismaClient({ adapter });
    try {
      // First establish that Prisma does NOT auto-escape these characters.
      await client.jobApplication.findMany({ where: { company: { contains: q, mode: 'insensitive' } }, select: { id: true } });
      expect(queries[0]?.args).toContain(q);
      const f = fixture(); f.findMany.mockImplementation(args => client.jobApplication.findMany(args));
      await f.service.list({ q, status: 'SAVED', cursor: encodeApplicationCursor({ id, createdAt: now }) }, proof);
      expect(queries).toHaveLength(2);
      const compiled = queries[1]!;
      expect(compiled.sql.match(/ILIKE/g)).toHaveLength(2);
      expect(compiled.args.filter(value => value === escaped)).toHaveLength(2);
      expect(compiled.args).toContain(userId); expect(compiled.args).toContain('SAVED'); expect(compiled.args).toContain(id);
      expect(compiled.sql).toContain('"archivedAt" IS NULL');
      expect(compiled.sql).toContain('ORDER BY'); expect(compiled.sql).toContain('LIMIT');
      expect(compiled.sql).toMatch(/"company" ILIKE \('%' \|\| \$\d+ \|\| '%'\)/);
      expect(compiled.sql).toMatch(/"jobTitle" ILIKE \('%' \|\| \$\d+ \|\| '%'\)/);
      expect(compiled.sql.match(/ OR /g)).toHaveLength(2); // Text and tuple alternatives remain separate.
      if (q.length > 1) expect(compiled.sql).not.toContain(q);
    } finally { await client.$disconnect(); }
    expect(dispose).toHaveBeenCalledOnce();
  });
});
