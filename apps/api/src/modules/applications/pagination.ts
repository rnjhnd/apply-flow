import { z } from 'zod';
import { applicationCursorSchema } from '@applyflow/contracts';
import { ApplicationHttpError } from './http-error.js';

const tuple = z.strictObject({ v: z.literal(1), createdAt: z.iso.datetime({ precision: 3 }), id: z.uuid() });
export function encodeApplicationCursor(row: { createdAt: Date; id: string }): string {
  const value = tuple.parse({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id.toLowerCase() });
  return applicationCursorSchema.parse(Buffer.from(JSON.stringify(value)).toString('base64url'));
}

export function decodeApplicationCursor(input: string): { createdAt: Date; id: string } {
  try {
    applicationCursorSchema.parse(input);
    const value = tuple.parse(JSON.parse(Buffer.from(input, 'base64url').toString('utf8')));
    const createdAt = new Date(value.createdAt);
    if (createdAt.toISOString() !== value.createdAt || encodeApplicationCursor({ createdAt, id: value.id }) !== input) throw new Error();
    return { createdAt, id: value.id };
  } catch { throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application cursor.'); }
}
