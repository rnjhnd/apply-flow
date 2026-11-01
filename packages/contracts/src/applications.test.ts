import { describe, expect, it } from 'vitest';
import { applicationDateSchema, applicationErrorResponseSchema, applicationSchema, applicationStatusSchema,
  createApplicationRequestSchema, createApplicationResponseSchema, listApplicationsQuerySchema,
  listApplicationsResponseSchema, updateApplicationRequestSchema, applicationStatusHistorySchema,
  listApplicationHistoryQuerySchema, listApplicationHistoryResponseSchema } from './applications.js';

const input = { company: 'Acme', jobTitle: 'Engineer' };
const dto = {
  id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', version: 1, ...input, status: 'SAVED', applicationDate: null,
  location: null, jobUrl: null, notes: null,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z'
};
const edit = { ...input, status: 'SAVED', applicationDate: null, location: null, jobUrl: null, notes: null, expectedVersion: 1 };

describe('complete versioned edits and history contracts', () => {
  it.each(Object.keys(edit))('requires the %s update key, including nullable values', field => {
    const omitted: Record<string, unknown> = { ...edit }; delete omitted[field];
    expect(updateApplicationRequestSchema.safeParse(omitted).success).toBe(false);
    expect(updateApplicationRequestSchema.safeParse({ ...edit, [field]: undefined }).success).toBe(false);
  });
  it.each(['id', 'userId', 'ownerId', 'version', 'createdAt', 'updatedAt', 'history', 'applicationVersion'])('rejects update override %s', field => {
    expect(updateApplicationRequestSchema.safeParse({ ...edit, [field]: 'injected' }).success).toBe(false);
  });
  it.each([0, -1, 1.5, '1', null, 2_147_483_648])('rejects invalid revision %#', expectedVersion => {
    expect(updateApplicationRequestSchema.safeParse({ ...edit, expectedVersion }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...dto, version: expectedVersion }).success).toBe(false);
  });
  it('normalizes existing fields while preserving meaningful notes and explicit nulls', () => {
    expect(updateApplicationRequestSchema.parse({ ...edit, company: ' Acme ', jobTitle: ' Engineer ',
      applicationDate: '', location: '  ', jobUrl: ' ', notes: ' line\n ' })).toEqual({ ...edit, notes: ' line\n ' });
    expect(updateApplicationRequestSchema.safeParse(edit).success).toBe(true);
    expect(applicationSchema.safeParse({ ...dto, version: undefined }).success).toBe(false);
    expect(applicationErrorResponseSchema.safeParse({ code: 'APPLICATION_CONFLICT', message: 'Reload application.' }).success).toBe(true);
  });
  it.each(applicationStatusSchema.options)('retains status/date requirements for %s', status => {
    expect(updateApplicationRequestSchema.safeParse({ ...edit, status }).success).toBe(status === 'SAVED');
    expect(updateApplicationRequestSchema.safeParse({ ...edit, status, applicationDate: '2024-02-29' }).success).toBe(true);
  });
  it.each([{ company: '' }, { jobTitle: 'x'.repeat(201) }, { notes: 'x'.repeat(4001) }, { location: 1 },
    { jobUrl: 'https://user:pass@example.invalid' }, { applicationDate: '2025-02-29' }, { notes: '\u0000' }])('retains input policies %#', change => {
    expect(updateApplicationRequestSchema.safeParse({ ...edit, ...change }).success).toBe(false);
  });
  it('uses canonical bounded integer history cursors and strict safe response fields', () => {
    expect(listApplicationHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listApplicationHistoryQuerySchema.parse({ limit: '50', cursor: '2147483647' })).toEqual({ limit: 50, cursor: '2147483647' });
    for (const cursor of ['', '0', '-1', '01', '1.0', ' 2', '2\n', '2147483648', 2, ['2']]) {
      expect(listApplicationHistoryQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
    for (const query of [{ limit: 51 }, { limit: 0 }, { ownerId: dto.id }]) expect(listApplicationHistoryQuerySchema.safeParse(query).success).toBe(false);
    const event = { id: dto.id, fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: 2, changedAt: dto.createdAt };
    expect(applicationStatusHistorySchema.parse(event)).toEqual(event);
    for (const change of [{ toStatus: 'SAVED' }, { applicationVersion: 1 }, { changedAt: '2026-10-22' },
      { applicationId: dto.id }, { userId: dto.id }, { csrfToken: 'secret' }]) {
      expect(applicationStatusHistorySchema.safeParse({ ...event, ...change }).success).toBe(false);
    }
    expect(listApplicationHistoryResponseSchema.safeParse({ items: Array(51).fill(event), nextCursor: null }).success).toBe(false);
  });
});

describe('application contracts', () => {
  it('defaults a saved application and normalizes optional blanks', () => {
    expect(createApplicationRequestSchema.parse({ company: ' Acme ', jobTitle: ' Engineer ',
      applicationDate: '', location: ' \n ', jobUrl: ' ', notes: '\t' })).toEqual({
      ...input, status: 'SAVED', applicationDate: null, location: null, jobUrl: null, notes: null
    });
    expect(createApplicationRequestSchema.parse(input).applicationDate).toBeNull();
  });
  it('preserves meaningful notes, internal spaces, Unicode and combining sequences', () => {
    const notes = '  Call Zoë\n\n  e\u0301: follow up 😀  ';
    expect(createApplicationRequestSchema.parse({ ...input, company: ' A  B ', notes }).notes).toBe(notes);
    expect(createApplicationRequestSchema.parse({ ...input, company: ' A  B ' }).company).toBe('A  B');
  });
  it.each(['SAVED', 'APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'])('validates %s and its date requirement', (status) => {
    expect(applicationStatusSchema.parse(status)).toBe(status);
    expect(createApplicationRequestSchema.safeParse({ ...input, status }).success).toBe(status === 'SAVED');
    expect(createApplicationRequestSchema.safeParse({ ...input, status, applicationDate: '2024-02-29' }).success).toBe(true);
  });
  it.each(['status', 'company', 'jobTitle', 'applicationDate', 'location', 'jobUrl', 'notes'])('rejects incorrect type for %s', (field) => {
    expect(createApplicationRequestSchema.safeParse({ ...input, [field]: 123 }).success).toBe(false);
  });
  it.each(['userId', 'ownerId', 'id', 'createdAt', 'updatedAt', 'archivedAt', 'user', 'password', 'csrfToken'])('rejects unapproved request property %s', (field) => {
    expect(createApplicationRequestSchema.safeParse({ ...input, [field]: 'injected' }).success).toBe(false);
  });
  it.each([['company', 160], ['jobTitle', 200], ['location', 200], ['notes', 4000]] as const)('counts %s limits in Unicode characters', (field, limit) => {
    expect(createApplicationRequestSchema.safeParse({ ...input, [field]: '😀'.repeat(limit) }).success).toBe(true);
    expect(createApplicationRequestSchema.safeParse({ ...input, [field]: '😀'.repeat(limit + 1) }).success).toBe(false);
  });
  it.each(['company', 'jobTitle'])('requires nonblank %s', (field) => {
    for (const value of ['', ' \n ', null, undefined]) expect(createApplicationRequestSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
  });
  it.each(['\ud800', '\udc00', '\u0000'])('rejects malformed/NUL text %j in every text field', (value) => {
    for (const field of ['company', 'jobTitle', 'location', 'notes', 'jobUrl']) {
      expect(createApplicationRequestSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
    }
  });
  it.each(['0001-01-01', '2000-02-29', '2024-02-29', '2026-10-22', '9999-12-31'])('accepts real date %s', (value) => {
    expect(applicationDateSchema.parse(value)).toBe(value);
  });
  it.each(['0000-01-01', '1900-02-29', '2025-02-29', '2024-02-30', '2026-04-31', '2026-00-01',
    '2026-13-01', '2026-01-00', '2026-1-01', '2026-01-1', ' 2026-01-01', '2026-01-01\n', '2026-01-01T00:00:00Z'])('rejects invalid calendar date %j', (value) => {
    expect(applicationDateSchema.safeParse(value).success).toBe(false);
  });
  it.each(['https://example.com/jobs/1?q=engineer#role', 'http://localhost:3000/jobs', 'HTTPS://example.com'])('allows HTTP URL %s', (jobUrl) => {
    expect(createApplicationRequestSchema.parse({ ...input, jobUrl: ` ${jobUrl} ` }).jobUrl).toBe(jobUrl);
  });
  it.each(['javascript:alert(1)', 'file:///jobs', 'ftp://example.com', '//example.com', '/jobs', 'https:example.com',
    'https://a:b@example.com', 'https://a@example.com', 'https://example.com/has space', 'https://example.com/\nfoo',
    'https:\\example.com', 'not-a-url'])('rejects unsafe URL %j', (jobUrl) => {
    expect(createApplicationRequestSchema.safeParse({ ...input, jobUrl }).success).toBe(false);
  });
  it('enforces the URL length', () => {
    const url = 'https://example.com/' + 'x'.repeat(2048 - 'https://example.com/'.length);
    expect(createApplicationRequestSchema.safeParse({ ...input, jobUrl: url }).success).toBe(true);
    expect(createApplicationRequestSchema.safeParse({ ...input, jobUrl: url + 'x' }).success).toBe(false);
  });
  it('keeps structural validation independent of the clock', () => {
    expect(createApplicationRequestSchema.safeParse({ ...input, applicationDate: '9999-12-31' }).success).toBe(true);
  });
  it('accepts explicit safe DTO envelopes', () => {
    expect(applicationSchema.parse(dto)).toEqual(dto);
    expect(createApplicationResponseSchema.parse({ application: dto })).toEqual({ application: dto });
    expect(listApplicationsResponseSchema.parse({ items: [dto], nextCursor: null })).toEqual({ items: [dto], nextCursor: null });
  });
  it.each(['userId', 'ownerId', 'user', 'sessions', 'passwordHash', 'csrfToken', 'tokenHash'])('rejects sensitive DTO property %s', (field) => {
    expect(applicationSchema.safeParse({ ...dto, [field]: 'secret' }).success).toBe(false);
  });
  it('does not normalize malformed response fields into valid responses', () => {
    for (const replacement of [{ company: ' Acme ' }, { id: 'bad' }, { createdAt: '2026-10-22' },
      { updatedAt: '2026-10-22T08:00:00.000+08:00' }, { status: 'APPLIED' }, { applicationDate: '' }]) {
      expect(applicationSchema.safeParse({ ...dto, ...replacement }).success).toBe(false);
    }
    expect(createApplicationResponseSchema.safeParse({ application: dto, userId: 'secret' }).success).toBe(false);
  });
  it('bounds list queries without silently truncating or accepting owners', () => {
    expect(listApplicationsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listApplicationsQuerySchema.parse({ limit: '50', cursor: 'abc_DEF-123' })).toEqual({ limit: 50, cursor: 'abc_DEF-123' });
    for (const limit of [0, 51, -1, 1.5, '01', '1.0', '', 'Infinity', true, null, ['20']]) {
      expect(listApplicationsQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(listApplicationsQuerySchema.safeParse({ userId: 'other' }).success).toBe(false);
  });
  it.each(['', 'a'.repeat(257), '../secret', 'https://example.com', 'a=b', 'a b'])('rejects malformed cursor %j', (cursor) => {
    expect(listApplicationsQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
  it('bounds list responses and error property names', () => {
    expect(listApplicationsResponseSchema.safeParse({ items: Array(51).fill(dto), nextCursor: null }).success).toBe(false);
    expect(applicationErrorResponseSchema.safeParse({ code: 'INVALID_REQUEST', message: 'Invalid fields.',
      fieldErrors: { applicationDate: ['Use a real date'] } }).success).toBe(true);
    expect(applicationErrorResponseSchema.safeParse({ code: 'INVALID_REQUEST', message: 'Invalid fields.',
      fieldErrors: { userId: ['secret'] } }).success).toBe(false);
    expect(applicationErrorResponseSchema.safeParse({ code: 'INTERNAL_ERROR', message: 'Unavailable.', stack: 'secret' }).success).toBe(false);
  });
});
