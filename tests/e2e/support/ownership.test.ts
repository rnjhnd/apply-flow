import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSessionService, type SessionDatabase } from '../../../apps/api/src/modules/auth/sessions.js';
import { hashSessionToken, isToken } from '../../../apps/api/src/modules/auth/tokens.js';
import { beforeFixtureWrite, ownedEmail, parseJournal, planCleanup, recordingTokenFactory,
  type OwnershipJournal } from './ownership.js';
import { createJournal, interruptedRun, readJournal, type JournalIo } from './journal.js';

const owner = { runId: randomUUID(), testId: randomUUID() };
const email = ownedEmail(owner, randomUUID());
function memoryIo() {
  let text: string | undefined;
  const io: JournalIo = { read: () => { if (text === undefined) throw new Error('Missing'); return text; },
    append: vi.fn((line: string, exclusive: boolean) => {
      if (exclusive && text !== undefined) throw new Error('File exists');
      text = (text ?? '') + line;
    }) };
  return { io, corrupt: (value: string) => { text = value; } };
}
function emptyJournal(): OwnershipJournal { return { version: 1, ...owner, state: 'stopped', events: [] }; }

describe('strict fixture ownership and fail-closed cleanup planning (no database I/O)', () => {
  it.each([undefined, null, {}, '', { ...emptyJournal(), password: 'forbidden' },
    { ...emptyJournal(), events: [{ kind: 'cookie', value: 'forbidden' }] }])('rejects missing/malformed journal %#', (value) => {
    expect(() => planCleanup(value, owner)).toThrow();
  });
  it('returns no cleanup targets for an empty ownership set', () => {
    expect(planCleanup(emptyJournal(), owner)).toEqual({ users: [], resolveEmails: [], sessionTokenHashes: [] });
  });
  it('requires exact run and test ownership, never only an email prefix or age', () => {
    expect(() => planCleanup(emptyJournal(), { ...owner, testId: randomUUID() })).toThrow('Unauthorized');
    expect(() => planCleanup(emptyJournal(), { ...owner, runId: randomUUID() })).toThrow('Unauthorized');
    expect(() => planCleanup({ ...emptyJournal(), events: [{ kind: 'email', value: 'e2e-old@example.invalid' }] }, owner)).toThrow('exact ownership');
    expect(() => planCleanup({ ...emptyJournal(), events: [{ kind: 'email', value: `${email}.evil` }] }, owner)).toThrow();
  });
  it('requires prior exact email intent for each UUID, rejects ambiguous UUID ownership', () => {
    const user = { kind: 'user', value: randomUUID(), email };
    expect(() => planCleanup({ ...emptyJournal(), events: [user] }, owner)).toThrow('Ambiguous');
    expect(() => planCleanup({ ...emptyJournal(), events: [{ kind: 'email', value: email }, user, user] }, owner)).toThrow('Ambiguous');
  });
  it('never plans cleanup while the child may still write', () => {
    expect(() => planCleanup({ ...emptyJournal(), state: 'running' }, owner)).toThrow('confirmed child exit');
  });
  it('rejects two different user UUIDs for one exact email before producing a plan', () => {
    const input = { ...emptyJournal(), events: [{ kind: 'email', value: email },
      { kind: 'user', value: randomUUID(), email }, { kind: 'user', value: randomUUID(), email }] };
    expect(() => parseJournal(input, owner)).toThrow('Ambiguous');
    expect(() => planCleanup(input, owner)).toThrow('Ambiguous');
  });
  it.each([false, true])('rejects duplicate UUIDs across casing, different email=%s', (differentEmail) => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondEmail = ownedEmail(owner, 'b');
    const input = { ...emptyJournal(), events: [{ kind: 'email', value: email },
      { kind: 'email', value: secondEmail }, { kind: 'user', value: userId, email },
      { kind: 'user', value: userId.toUpperCase(), email: differentEmail ? secondEmail : email }] };
    expect(() => parseJournal(input, owner)).toThrow('Ambiguous');
    expect(() => planCleanup(input, owner)).toThrow('Ambiguous');
  });
  it('rejects the same UUID assigned to multiple exact emails', () => {
    const secondEmail = ownedEmail(owner, 'b'); const userId = randomUUID();
    expect(() => planCleanup({ ...emptyJournal(), events: [{ kind: 'email', value: email },
      { kind: 'email', value: secondEmail }, { kind: 'user', value: userId, email },
      { kind: 'user', value: userId, email: secondEmail }] }, owner)).toThrow('Ambiguous');
  });
  it.each(['missing', 'different', 'late'] as const)('rejects %s email intent', (mode) => {
    const user = { kind: 'user', value: randomUUID(), email };
    const events = mode === 'missing' ? [user] : mode === 'late'
      ? [user, { kind: 'email', value: email }]
      : [{ kind: 'email', value: ownedEmail(owner, 'b') }, user];
    expect(() => planCleanup({ ...emptyJournal(), events }, owner)).toThrow('Ambiguous');
  });
  it.each(['email', 'tokenHash'] as const)('rejects duplicate %s metadata', (kind) => {
    const event = kind === 'email' ? { kind, value: email } : { kind, value: 'a'.repeat(64) };
    expect(() => planCleanup({ ...emptyJournal(), events: [event, event] }, owner)).toThrow('Duplicate');
  });
  it('accepts independent users and canonicalizes UUIDs without changing exact email predicates', () => {
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const secondId = randomUUID();
    const secondEmail = ownedEmail(owner, 'b');
    const input = { ...emptyJournal(), events: [{ kind: 'email', value: email },
      { kind: 'user', value: firstId.toUpperCase(), email }, { kind: 'email', value: secondEmail },
      { kind: 'user', value: secondId, email: secondEmail }] };
    expect(planCleanup(input, owner)).toEqual({ users: [{ id: firstId, email }, { id: secondId, email: secondEmail }],
      resolveEmails: [email, secondEmail], sessionTokenHashes: [] });
  });
  it('plans exact user UUID/email pairs and candidate session hashes only', () => {
    const userId = randomUUID(); const tokenHash = 'a'.repeat(64);
    expect(planCleanup({ ...emptyJournal(), events: [{ kind: 'email', value: email },
      { kind: 'user', value: userId, email }, { kind: 'tokenHash', value: tokenHash }] }, owner)).toEqual({
      users: [{ id: userId, email }], resolveEmails: [email], sessionTokenHashes: [tokenHash]
    });
  });
});

describe('durable ownership ordering and interrupted runs with injected storage', () => {
  it('refuses conflicting ownership before appending metadata or admitting a fixture write', () => {
    const { io } = memoryIo(); const journal = createJournal(io, owner);
    journal.record({ kind: 'email', value: email });
    journal.record({ kind: 'user', value: randomUUID(), email });
    const before = io.read(); const write = vi.fn();
    expect(() => beforeFixtureWrite(journal.record, { kind: 'user', value: randomUUID(), email }, write)).toThrow('Ambiguous');
    expect(io.read()).toBe(before); expect(write).not.toHaveBeenCalled();
  });
  it('journals exact intent before fixture writes and refuses reuse', () => {
    const { io } = memoryIo(); const journal = createJournal(io, owner);
    const write = vi.fn(() => { expect(readJournal(io, owner).events).toEqual([{ kind: 'email', value: email }]); return 'written'; });
    expect(beforeFixtureWrite(journal.record, { kind: 'email', value: email }, write)).toBe('written');
    expect(write).toHaveBeenCalledOnce(); expect(() => createJournal(io, owner)).toThrow('File exists');
  });
  it('failure to persist ownership prevents the associated fixture write/token return', () => {
    const record = vi.fn(() => { throw new Error('Mock fsync failure'); }); const write = vi.fn();
    expect(() => beforeFixtureWrite(record, { kind: 'email', value: email }, write)).toThrow('fsync');
    expect(() => recordingTokenFactory(record)()).toThrow('fsync'); expect(write).not.toHaveBeenCalled();
  });
  it('rejects asynchronous recording before admitting writes or returning a token', () => {
    const record = () => Promise.resolve(); const write = vi.fn();
    expect(() => beforeFixtureWrite(record, { kind: 'email', value: email }, write)).toThrow('synchronously');
    expect(() => recordingTokenFactory(record)()).toThrow('synchronously'); expect(write).not.toHaveBeenCalled();
  });
  it('uses unchanged crypto and records only hashes before anonymous session insertion', async () => {
    const { io } = memoryIo(); const journal = createJournal(io, owner);
    const create = vi.fn().mockImplementation(async (args: { data: { tokenHash: string; csrfToken: string } }) => {
      const hashes = readJournal(io, owner).events.map((e) => e.value);
      expect(hashes).toContain(args.data.tokenHash);
      expect(hashes).toContain(hashSessionToken(args.data.csrfToken));
      return { id: randomUUID(), ...args.data };
    });
    const database = { session: { create } } as unknown as SessionDatabase;
    const service = createSessionService(database, { token: recordingTokenFactory(journal.record) });
    const result = await service.createAnonymous();
    expect(isToken(result.token)).toBe(true); expect(result.token).not.toBe(result.session.csrfToken);
    const text = io.read();
    expect(text).not.toContain(result.token); expect(text).not.toContain(result.session.csrfToken);
    expect(text).not.toContain('postgresql:'); expect(create).toHaveBeenCalledOnce();
  });
  it('cannot insert an anonymous session after journaling failure', async () => {
    const create = vi.fn(); const database = { session: { create } } as unknown as SessionDatabase;
    const service = createSessionService(database, { token: recordingTokenFactory(() => { throw new Error('Mock durable write failure'); }) });
    await expect(service.createAnonymous()).rejects.toThrow('durable write failure');
    expect(create).not.toHaveBeenCalled();
  });
  it('marks interrupted/running journals for review without cleanup, and closes only explicitly', () => {
    const { io } = memoryIo(); const journal = createJournal(io, owner);
    expect(interruptedRun(io, owner)).toBe('review-required');
    expect(() => planCleanup(readJournal(io, owner), owner)).toThrow('confirmed child exit');
    journal.markExited(); expect(interruptedRun(io, owner)).toBe('stopped');
    expect(() => journal.record({ kind: 'email', value: email })).toThrow('closed');
    expect(() => journal.markExited()).toThrow('already closed');
  });
  it.each(['', '{bad}\n', '{}\n'])('rejects corrupt journals without automatic salvage %#', (text) => {
    const { io, corrupt } = memoryIo(); corrupt(text);
    expect(() => readJournal(io, owner)).toThrow('manual review');
  });
  it('rejects a partial append, reordered history, or competing writer', () => {
    const { io, corrupt } = memoryIo(); const journal = createJournal(io, owner); const first = io.read();
    corrupt(first + '{'); expect(() => readJournal(io, owner)).toThrow('manual review');
    corrupt(first + first); expect(() => readJournal(io, owner)).toThrow('manual review');
    corrupt(first); journal.record({ kind: 'email', value: email }); const second = io.read();
    corrupt(first); expect(() => journal.record({ kind: 'tokenHash', value: 'a'.repeat(64) })).toThrow('Concurrent');
    corrupt(second); expect(parseJournal(readJournal(io, owner), owner).events).toHaveLength(1);
  });
});
