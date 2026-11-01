import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { applicationStatusSchema, type ApplicationStatus, type UpdateApplicationRequest } from '@applyflow/contracts';
import type { JobApplication, Session, ApplicationStatusHistory } from '../../generated/prisma/client.ts';
import { createApplicationService, type ApplicationTransaction } from './service.js';
import { hashSessionToken } from '../auth/tokens.js';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';

const id = 'c4974360-a70c-4a29-8b41-df95d15d7270';
const userId = 'fe97bd36-272f-4da9-bba5-61eea12ccf3e';
const now = new Date('2026-10-22T12:00:00.000Z');
const before = new Date('2026-10-22T11:00:00.000Z');
const proof = { token: 'a'.repeat(64), csrfToken: 'b'.repeat(64) };
const secondProof = { token: 'd'.repeat(64), csrfToken: 'e'.repeat(64) };
const input: UpdateApplicationRequest = { company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
  applicationDate: null, location: null, jobUrl: null, notes: null, expectedVersion: 1 };
type State = { application: JobApplication; sessions: Session[]; history: ApplicationStatusHistory[] };

// A local staged transaction double, not a PostgreSQL lock simulator. Failed
// callbacks/commits discard staged changes; a gate gives deterministic contention.
function fixture(status: ApplicationStatus = 'SAVED') {
  let state: State = { application: { id, userId, company: 'Acme', jobTitle: 'Engineer', status,
    applicationDate: status === 'SAVED' ? null : new Date('2024-02-29T00:00:00.000Z'),
    location: null, jobUrl: null, notes: null, version: 1, createdAt: before, updatedAt: before },
  sessions: [proof, secondProof].map((p, index) => ({ id: index === 0 ? id : userId, userId,
    tokenHash: hashSessionToken(p.token), csrfToken: p.csrfToken, createdAt: before, lastSeenAt: before,
    expiresAt: new Date('2026-10-23T12:00:00.000Z') })), history: [] };
  const faults = { history: false, response: false, commit: false, refresh: false };
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let queue = Promise.resolve();
  let onApplicationLock: (() => Promise<void>) | undefined;
  const update = vi.fn(); const insert = vi.fn(); const historyRead = vi.fn(); const find = vi.fn();
  const host = { $transaction: async <T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T> => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const staged = structuredClone(state);
    try {
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('?'); calls.push({ text, values });
          if (text.includes('FROM public."Session"')) return staged.sessions.filter(s => s.tokenHash === values[0]);
          if (text.includes('UPDATE public."Session"')) {
            const session = staged.sessions.find(s => s.tokenHash === values[1]);
            if (!session || faults.refresh) return [];
            session.lastSeenAt = values[0] as Date; return [session];
          }
          if (text.includes('FROM public."JobApplication"')) {
            await onApplicationLock?.();
            return staged.application.id === values[0] && staged.application.userId === values[1] ? [structuredClone(staged.application)] : [];
          }
          throw new Error('Unexpected fake SQL');
        },
        jobApplication: {
          findFirst: find.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) =>
            staged.application.id === where.id && staged.application.userId === where.userId ? structuredClone(staged.application) : null),
          update: update.mockImplementation(async ({ where, data }: { where: { id: string; userId: string }; data: Partial<JobApplication> }) => {
            expect(where).toEqual({ id, userId });
            Object.assign(staged.application, data);
            return { ...staged.application, ...(faults.response ? { company: '' } : {}) };
          })
        },
        applicationStatusHistory: {
          create: insert.mockImplementation(async ({ data }: { data: Omit<ApplicationStatusHistory, 'id' | 'changedAt'> }) => {
            if (faults.history) throw new Error('private database credential=SECRET');
            const row = { ...data, id: randomUUID(), changedAt: now }; staged.history.push(row); return row;
          }),
          findMany: historyRead.mockImplementation(async ({ where, take }: {
            where: { applicationId: string; application: { userId: string }; applicationVersion?: { lt: number } }; take: number
          }) => staged.history.filter(h => h.applicationId === where.applicationId && staged.application.userId === where.application.userId
            && (where.applicationVersion === undefined || h.applicationVersion < where.applicationVersion.lt))
            .sort((a, b) => b.applicationVersion - a.applicationVersion).slice(0, take))
        }
      } as unknown as ApplicationTransaction;
      const result = await work(tx);
      if (faults.commit) throw new Error('private commit outcome');
      state = staged;
      return result;
    } finally { release(); }
  } };
  const transaction = vi.spyOn(host, '$transaction');
  return { service: createApplicationService(host, { now: () => now, timeZone: 'America/Los_Angeles' }),
    read: () => structuredClone(state), change: (work: (state: State) => void) => work(state),
    hold: (handler: () => Promise<void>) => { onApplicationLock = handler; }, faults, calls,
    transaction, update, insert, find, historyRead };
}

describe('atomic owner-scoped edits and status history (offline)', () => {
  const transitions = applicationStatusSchema.options.flatMap(from => applicationStatusSchema.options.filter(to => to !== from).map(to => ({ from, to })));
  it.each(transitions)('records exactly one real $from -> $to transition', async ({ from, to }) => {
    const f = fixture(from);
    const result = await f.service.update(id, { ...input, status: to, applicationDate: '2024-02-29' }, proof);
    expect(result.application).toMatchObject({ version: 2, status: to, applicationDate: '2024-02-29' });
    expect(f.read().history).toEqual([expect.objectContaining({ applicationId: id, fromStatus: from, toStatus: to, applicationVersion: 2 })]);
    expect(f.insert).toHaveBeenCalledOnce();
    expect(f.insert.mock.calls[0]![0].data).not.toHaveProperty('changedAt');
    expect(f.calls.map(c => c.text)).toEqual([
      expect.stringContaining('FROM public."Session"'), expect.stringContaining('UPDATE public."Session"'),
      expect.stringContaining('FROM public."JobApplication"')
    ]);
    expect(f.calls[0]!.text).toContain('FOR UPDATE');
    expect(f.calls[2]).toMatchObject({ text: expect.stringContaining('FOR UPDATE'), values: [id, userId] });
    expect(f.calls[2]!.text).toContain('AND "userId" =');
  });
  it('preserves a complete normalized no-op including version and updatedAt', async () => {
    const f = fixture(); const old = f.read().application;
    const result = await f.service.update(id, { ...input, company: ' Acme ', location: ' ', notes: '' }, proof);
    expect(f.read().application).toEqual(old); expect(result.application.version).toBe(1);
    expect(result.application.updatedAt).toBe(before.toISOString());
    expect(f.update).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
  });
  it('increments once for non-status changes, preserves identity and meaningful notes, and adds no history', async () => {
    const f = fixture();
    const result = await f.service.update(id, { ...input, company: ' New company ', notes: ' line\n ' }, proof);
    expect(result.application).toMatchObject({ id, company: 'New company', notes: ' line\n ', version: 2,
      createdAt: before.toISOString(), updatedAt: now.toISOString() });
    expect(f.read().application.userId).toBe(userId); expect(f.read().history).toEqual([]);
    expect(Object.keys(f.update.mock.calls[0]![0].data).sort()).toEqual([
      'applicationDate','company','jobTitle','jobUrl','location','notes','status','updatedAt','version'
    ]);
  });
  it.each([null, '2024-02-29'])('allows returning to Saved with explicit date %#', async applicationDate => {
    const f = fixture('APPLIED');
    const result = await f.service.update(id, { ...input, applicationDate }, proof);
    expect(result.application.applicationDate).toBe(applicationDate);
  });
  it.each(['0001-01-01', '0099-12-31', '2024-02-29', '2026-10-22'])('preserves PostgreSQL DATE semantics on update: %s', async applicationDate => {
    const f = fixture();
    const result = await f.service.update(id, { ...input, status: 'APPLIED', applicationDate }, proof);
    expect(result.application.applicationDate).toBe(applicationDate);
    expect(f.read().application.applicationDate?.toISOString()).toBe(applicationDate + 'T00:00:00.000Z');
  });
  it('leaves revision gaps for field edits without inventing history', async () => {
    const f = fixture();
    await f.service.update(id, { ...input, notes: 'Changed notes' }, proof);
    await f.service.update(id, { ...input, notes: 'Changed notes', status: 'APPLIED', applicationDate: '2024-02-29', expectedVersion: 2 }, proof);
    expect(f.read().application.version).toBe(3);
    expect(f.read().history.map(row => row.applicationVersion)).toEqual([3]);
  });
  it.each([{ status: 'APPLIED' }, { status: 'INTERVIEW' }, { applicationDate: '2026-02-30' },
    { status: 'APPLIED', applicationDate: '2026-10-23' }, { status: undefined }, { expectedVersion: 0 }, { userId }, { version: 2 }])(
    'rejects invalid/date/owner overrides before constructing a transaction %#', async change => {
      const f = fixture(); await expect(f.service.update(id, { ...input, ...change }, proof)).rejects.toMatchObject({ status: 400 });
      expect(f.transaction).not.toHaveBeenCalled();
    });
  it('rejects stale versions even for a no-op and rolls back the staged refresh', async () => {
    const f = fixture(); f.change(s => { s.application.version = 2; }); const old = f.read();
    await expect(f.service.update(id, input, proof)).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CONFLICT' });
    expect(f.read()).toEqual(old); expect(f.update).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
  });
  it.each(['missing', 'foreign'] as const)('returns indistinguishable 404s for %s parents on every endpoint', async kind => {
    const f = fixture(); f.change(s => { if (kind === 'missing') s.application.id = userId; else s.application.userId = id; });
    for (const pending of [() => f.service.get(id, proof), () => f.service.update(id, input, proof), () => f.service.history(id, {}, proof)]) {
      await expect(pending()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Application not found.' });
    }
    expect(f.update).not.toHaveBeenCalled(); expect(f.historyRead).not.toHaveBeenCalled();
  });
  it.each(['missing', 'anonymous', 'expired'] as const)('requires a valid authenticated session on all endpoints: %s', async kind => {
    const f = fixture(); f.change(s => { if (kind === 'missing') s.sessions = []; else if (kind === 'anonymous') s.sessions[0]!.userId = null; else s.sessions[0]!.expiresAt = now; });
    for (const pending of [() => f.service.get(id, proof), () => f.service.update(id, input, proof), () => f.service.history(id, {}, proof)]) {
      await expect(pending()).rejects.toMatchObject({ status: 401 });
    }
    expect(f.find).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.historyRead).not.toHaveBeenCalled();
  });
  it.each([undefined, 'incorrect', 'f'.repeat(64)])('rejects PUT CSRF before application locking %#', async csrfToken => {
    const f = fixture(); const old = f.read();
    await expect(f.service.update(id, input, { token: proof.token, csrfToken })).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(1); expect(f.read()).toEqual(old);
  });
  it('rejects a failed locked session refresh before application access', async () => {
    const f = fixture(); f.faults.refresh = true;
    await expect(f.service.update(id, input, proof)).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(2); expect(f.update).not.toHaveBeenCalled();
  });
  it.each(['bad', '../secret', '', ['bad']])('validates UUIDs on every service entrypoint %#', async key => {
    const f = fixture();
    for (const pending of [() => f.service.get(key, proof), () => f.service.update(key, input, proof), () => f.service.history(key, {}, proof)]) {
      await expect(pending()).rejects.toMatchObject({ status: 400 });
    }
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(['history', 'response', 'commit'] as const)('discards staged application/history/session changes on %s failure without retry', async fault => {
    const f = fixture(); f.faults[fault] = true; const old = f.read();
    const failure = await f.service.update(id, { ...input, status: 'APPLIED', applicationDate: '2024-02-29' }, proof).catch(e => e);
    expect(failure).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(String(failure)).not.toContain('SECRET'); expect(f.read()).toEqual(old);
    expect(f.transaction).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledOnce(); expect(f.insert).toHaveBeenCalledOnce();
  });
  it('returns only public detail fields with the current version', async () => {
    const f = fixture(); const result = await f.service.get(id, proof);
    expect(result.application.version).toBe(1);
    expect(result.application).not.toHaveProperty('userId'); expect(result.application).not.toHaveProperty('statusHistory');
    expect(f.find).toHaveBeenCalledWith(expect.objectContaining({ where: { id, userId }, select: expect.objectContaining({ version: true }) }));
  });
  it('walks history by strictly older revisions, with gaps, default/max size, lookahead and a final null cursor', async () => {
    const f = fixture(); f.change(s => {
      s.history = Array.from({ length: 52 }, (_, index) => ({ id: randomUUID(), applicationId: id,
        fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: index * 2 + 2, changedAt: now }));
    });
    expect((await f.service.history(id, {}, proof)).items).toHaveLength(20);
    const first = await f.service.history(id, { limit: '50' }, proof);
    expect(first.items.map(r => r.applicationVersion)).toEqual(Array.from({ length: 50 }, (_, i) => 104 - i * 2));
    expect(first.nextCursor).toBe('6');
    const last = await f.service.history(id, { limit: '50', cursor: first.nextCursor }, proof);
    expect(last.items.map(r => r.applicationVersion)).toEqual([4, 2]); expect(last.nextCursor).toBeNull();
    expect((await f.service.history(id, { cursor: '1' }, proof)).items).toEqual([]);
    expect(f.historyRead).toHaveBeenCalledWith(expect.objectContaining({ where: { applicationId: id, application: { userId }, applicationVersion: { lt: 6 } }, orderBy: { applicationVersion: 'desc' }, take: 51 }));
    expect(Object.keys(first.items[0]!).sort()).toEqual(['applicationVersion','changedAt','fromStatus','id','toStatus']);
  });
  it.each([{ limit: '51' }, { cursor: '01' }, { cursor: ['2'] }, { userId }])('rejects malformed history query %#', async query => {
    const f = fixture(); await expect(f.service.history(id, query, proof)).rejects.toMatchObject({ status: 400 }); expect(f.transaction).not.toHaveBeenCalled();
  });
  it('validates history responses before committing the session refresh', async () => {
    const f = fixture(); f.change(s => { s.history.push({ id, applicationId: id, fromStatus: 'SAVED', toStatus: 'SAVED', applicationVersion: 2, changedAt: now }); });
    const old = f.read();
    await expect(f.service.history(id, {}, proof)).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(f.read()).toEqual(old);
  });
  it('accepts one of two competing same-version saves and rejects the other, then records the actual next transition', async () => {
    const f = fixture(); let release!: () => void; let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    f.hold(async () => { ready(); await gate; });
    const first = f.service.update(id, { ...input, status: 'APPLIED', applicationDate: '2024-02-29' }, proof);
    await locked;
    const second = f.service.update(id, { ...input, status: 'INTERVIEW', applicationDate: '2024-02-29' }, secondProof);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results[0]!.status).toBe('fulfilled'); expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(f.read().history).toHaveLength(1); expect(f.update).toHaveBeenCalledOnce();
    await f.service.update(id, { ...input, status: 'INTERVIEW', applicationDate: '2024-02-29', expectedVersion: 2 }, secondProof);
    expect(f.read().history.map(h => [h.fromStatus, h.toStatus, h.applicationVersion])).toEqual([['SAVED','APPLIED',2],['APPLIED','INTERVIEW',3]]);
  });
  it('fails safely at the maximum PostgreSQL revision while still permitting a no-op', async () => {
    const f = fixture(); f.change(s => { s.application.version = 2_147_483_647; });
    await f.service.update(id, { ...input, expectedVersion: 2_147_483_647 }, proof);
    await expect(f.service.update(id, { ...input, expectedVersion: 2_147_483_647, notes: 'change' }, proof)).rejects.toMatchObject({ status: 503 });
    expect(f.update).not.toHaveBeenCalled();
  });
  it('enforces owner isolation and session-bound CSRF through the real HTTP/service composition', async () => {
    const f = fixture();
    const app = createApp(parseEnv({ NODE_ENV: 'test' }), {
      config: parseAuthConfig({ NODE_ENV: 'test' }), sessions: { findValid: vi.fn(), createAnonymous: vi.fn() }
    }, { applications: f.service });
    const path = '/api/applications/' + id;
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-ApplyFlow-Request': '1',
      Cookie: 'applyflow_session=' + proof.token, 'X-CSRF-Token': proof.csrfToken };
    await request(app).get(path).set(headers).expect(200).expect(response => { expect(response.body.application.version).toBe(1); });
    await request(app).put(path).set(headers).unset('X-CSRF-Token').send(input).expect(403);
    await request(app).put(path).set(headers).send({ ...input, status: 'APPLIED', applicationDate: '2024-02-29' }).expect(200);
    await request(app).get(path + '/history').set(headers).expect(200).expect(response => { expect(response.body.items).toHaveLength(1); });
    f.change(s => { s.application.userId = id; });
    await request(app).get(path).set(headers).expect(404);
    await request(app).put(path).set(headers).send({ ...input, expectedVersion: 2 }).expect(404);
    await request(app).get(path + '/history').set(headers).expect(404);
  });
});
