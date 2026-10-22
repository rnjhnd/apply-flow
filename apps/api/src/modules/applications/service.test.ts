import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../generated/prisma/client.ts';
import { createApplicationService, type ApplicationTransaction } from './service.js';
import { decodeApplicationCursor, encodeApplicationCursor } from './pagination.js';

const userId = 'fe97bd36-272f-4da9-bba5-61eea12ccf3e';
const id = 'c4974360-a70c-4a29-8b41-df95d15d7270';
const now = new Date('2026-10-22T01:00:00.000Z');
const proof = { token: 'a'.repeat(64), csrfToken: 'b'.repeat(64) };
const input = { company: ' Acme ', jobTitle: ' Engineer ' };
const row = { id, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED' as const, applicationDate: null as Date | null,
  location: null, jobUrl: null, notes: null, createdAt: now, updatedAt: now, userId, passwordHash: 'PRIVATE' };
function fixture() {
  const session: Session = { id, userId, tokenHash: 'c'.repeat(64), csrfToken: proof.csrfToken,
    createdAt: now, lastSeenAt: now, expiresAt: new Date('2026-10-23T01:00:00.000Z') };
  const raw = vi.fn().mockImplementation(async () => [session]);
  const create = vi.fn().mockResolvedValue(row);
  const findMany = vi.fn().mockResolvedValue([row]);
  const transaction = { $queryRaw: raw, jobApplication: { create, findMany }, session: {} } as unknown as ApplicationTransaction;
  const host = { $transaction: vi.fn(async <T>(work: (tx: ApplicationTransaction) => Promise<T>) => work(transaction)) };
  return { service: createApplicationService({ $transaction: <T>(work: (tx: ApplicationTransaction) => Promise<T>) => host.$transaction(work) as Promise<T> },
    { now: () => now, timeZone: 'Asia/Manila' }), host, raw, create, findMany, session };
}
describe('owner-scoped application transactions', () => {
  it('derives owner from the locked session, refreshes it and returns only public fields', async () => {
    const f = fixture(); const result = await f.service.create(input, proof);
    expect(f.raw.mock.calls[0]?.[0].join(' ')).toContain('FOR UPDATE');
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ data: { userId, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED', notes: null } });
    expect(f.create.mock.calls[0]?.[0].select.userId).toBeUndefined();
    expect(result.application).not.toHaveProperty('userId'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each(['userId', 'id', 'createdAt', 'passwordHash'])('rejects injected %s before transaction construction', async field => {
    const f = fixture(); await expect(f.service.create({ ...input, [field]: userId }, proof)).rejects.toMatchObject({ status: 400 });
    expect(f.host.$transaction).not.toHaveBeenCalled();
  });
  it.each(['anonymous', 'missing', 'expired'] as const)('rejects %s sessions before application access', async kind => {
    const f = fixture();
    if (kind === 'anonymous') f.session.userId = null;
    if (kind === 'missing') f.raw.mockResolvedValue([]);
    if (kind === 'expired') f.session.expiresAt = now;
    await expect(f.service.create(input, proof)).rejects.toMatchObject({ status: 401 }); expect(f.create).not.toHaveBeenCalled();
    await expect(f.service.list({}, proof)).rejects.toMatchObject({ status: 401 }); expect(f.findMany).not.toHaveBeenCalled();
  });
  it.each([undefined, 'wrong', 'd'.repeat(64)])('rejects missing/wrong CSRF %j without mutation', async csrfToken => {
    const f = fixture(); await expect(f.service.create(input, { token: proof.token, csrfToken })).rejects.toMatchObject({ status: 403 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.raw).toHaveBeenCalledOnce();
  });
  it('rechecks session after lock waiting, never using a pre-lock owner', async () => {
    const f = fixture(); f.raw.mockImplementationOnce(async () => { f.session.userId = null; return [f.session]; });
    await expect(f.service.create(input, proof)).rejects.toMatchObject({ status: 401 }); expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects a failed session refresh before reading or creating applications', async () => {
    const f = fixture(); f.raw.mockResolvedValueOnce([f.session]).mockResolvedValueOnce([]);
    await expect(f.service.list({}, proof)).rejects.toMatchObject({ status: 401 }); expect(f.findMany).not.toHaveBeenCalled();
  });
  it.each(['2026-10-23', '2026-02-30'])('rejects invalid/future date %s before writes', async applicationDate => {
    const f = fixture(); await expect(f.service.create({ ...input, status: 'APPLIED', applicationDate }, proof)).rejects.toMatchObject({ status: 400, fieldErrors: { applicationDate: expect.any(Array) } });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['0001-01-01', '0099-12-31', '2024-02-29', '2026-10-22'])('round trips DATE %s without numeric-year or timezone conversion', async applicationDate => {
    const f = fixture(); f.create.mockImplementation(async args => ({ ...row, ...args.data }));
    const result = await f.service.create({ ...input, status: 'APPLIED', applicationDate }, proof);
    expect(result.application.applicationDate).toBe(applicationDate);
    expect(f.create.mock.calls[0]?.[0].data.applicationDate.toISOString()).toBe(`${applicationDate}T00:00:00.000Z`);
  });
  it('refuses a non-midnight DATE driver value rather than shifting the date', async () => {
    const f = fixture(); f.findMany.mockResolvedValue([{ ...row, applicationDate: now }]);
    await expect(f.service.list({}, proof)).rejects.toMatchObject({ status: 503 });
  });
  it('always scopes list data to the session owner and excludes another user', async () => {
    const f = fixture(); const foreign = { ...row, userId: id, company: 'Foreign company' };
    f.findMany.mockImplementation(async args => [row, foreign].filter(value => value.userId === args.where.userId));
    expect((await f.service.list({}, proof)).items.map(value => value.company)).toEqual(['Acme']);
    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId }, take: 21, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  });
  it('uses a strict descending tuple boundary and the last returned item for the next cursor', async () => {
    const f = fixture(); f.findMany.mockResolvedValue([row, { ...row, id: userId }]);
    const cursor = encodeApplicationCursor(row);
    const result = await f.service.list({ limit: '1', cursor }, proof);
    expect(f.findMany.mock.calls[0]?.[0].where).toEqual({ userId, OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: id } }] });
    expect(result.items).toHaveLength(1); expect(decodeApplicationCursor(result.nextCursor!)).toEqual({ createdAt: now, id });
    expect(f.findMany.mock.calls[0]?.[0].take).toBe(2);
  });
  it.each([{}, { limit: '50' }])('ends pagination without an extra row for %j', async query => {
    const f = fixture(); expect((await f.service.list(query, proof)).nextCursor).toBeNull();
  });
  it.each([{ limit: '51' }, { limit: ['1','2'] }, { ownerId: userId }, { cursor: 'abc' }])('rejects invalid queries %j before database access', async query => {
    const f = fixture(); await expect(f.service.list(query, proof)).rejects.toMatchObject({ status: 400 }); expect(f.host.$transaction).not.toHaveBeenCalled();
  });
  it('sanitizes transaction/commit failure and does not replay creation', async () => {
    const f = fixture(); f.host.$transaction.mockImplementationOnce(async work => { await work({ $queryRaw: f.raw, jobApplication: { create: f.create } } as unknown as ApplicationTransaction); throw new Error('postgresql://SECRET'); });
    const error = await f.service.create(input, proof).catch(value => value);
    expect(error).toMatchObject({ status: 503 }); expect(String(error)).not.toContain('SECRET'); expect(f.create).toHaveBeenCalledOnce(); expect(f.host.$transaction).toHaveBeenCalledOnce();
  });
});
