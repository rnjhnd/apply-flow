import { describe, expect, it } from 'vitest';
import { decodeApplicationCursor, encodeApplicationCursor } from './pagination.js';

const row = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', createdAt: new Date('2026-10-22T01:02:03.456Z') };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('strict application tuple cursors', () => {
  it('round trips the exact timestamp/UUID, without ownership data', () => {
    const cursor = encodeApplicationCursor(row);
    expect(decodeApplicationCursor(cursor)).toEqual(row);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id });
  });
  it.each(['', 'abc', '../x', 'a'.repeat(257), encode({}), encode({ v: 2, createdAt: row.createdAt.toISOString(), id: row.id }),
    encode({ v: 1, createdAt: '2026-02-30T00:00:00.000Z', id: row.id }),
    encode({ v: 1, createdAt: row.createdAt.toISOString(), id: 'invalid' }),
    encode({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id, userId: row.id }),
    encode({ id: row.id, v: 1, createdAt: row.createdAt.toISOString() }), encodeApplicationCursor(row) + '='])('rejects noncanonical/invalid cursor %j', value => {
    expect(() => decodeApplicationCursor(value)).toThrow('Invalid application cursor');
  });
});
