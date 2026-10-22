import { z } from 'zod';

export const applicationStatusSchema = z.enum([
  'SAVED', 'APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'
]);

// PostgreSQL character limits count Unicode code points, not UTF-16 code units.
function text(limit: number) {
  return z.string().refine((value) => {
    const characters = Array.from(value);
    return characters.length <= limit && characters.every((character) => {
      const code = character.codePointAt(0)!;
      return code !== 0 && (code < 0xd800 || code > 0xdfff);
    });
  }, `Use at most ${limit} valid Unicode characters without NUL`);
}

const requiredText = (limit: number) => z.string().trim().pipe(text(limit)).refine((value) => value.length > 0, 'Required');
const canonicalText = (limit: number) => text(limit).refine((value) => value.length > 0 && value === value.trim(), 'Use trimmed text');
const optionalInput = <T extends z.ZodType>(schema: T, trim: boolean) => z.preprocess((value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  // Validate before normalization: trimming must not hide malformed input.
  if (!text(Number.MAX_SAFE_INTEGER).safeParse(value).success) return value;
  if (!value.trim()) return null;
  return trim ? value.trim() : value;
}, schema.nullable());

export const applicationDateSchema = z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}, 'Use a real YYYY-MM-DD calendar date');

const jobUrlSchema = canonicalText(2048).refine((value) => {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  return !!authority && !authority.includes('@') && !/[\s\\]/u.test(value);
}, 'Use an absolute HTTP or HTTPS URL without credentials').pipe(z.url({ protocol: /^https?$/ }));

const createFields = {
  company: requiredText(160),
  jobTitle: requiredText(200),
  status: applicationStatusSchema.default('SAVED'),
  applicationDate: optionalInput(applicationDateSchema, false),
  location: optionalInput(canonicalText(200), true),
  jobUrl: optionalInput(jobUrlSchema, true),
  notes: optionalInput(text(4000), false)
};
const hasRequiredDate = (value: { status: string; applicationDate: string | null }) =>
  value.status === 'SAVED' || value.applicationDate !== null;

export const createApplicationRequestSchema = z.strictObject(createFields).refine(hasRequiredDate, {
  path: ['applicationDate'], message: 'Application date is required for this status'
});

export const applicationSchema = z.strictObject({
  id: z.uuid(), company: canonicalText(160), jobTitle: canonicalText(200), status: applicationStatusSchema,
  applicationDate: applicationDateSchema.nullable(), location: canonicalText(200).nullable(),
  jobUrl: jobUrlSchema.nullable(), notes: text(4000).nullable(),
  createdAt: z.iso.datetime({ precision: 3 }), updatedAt: z.iso.datetime({ precision: 3 })
}).refine(hasRequiredDate, { path: ['applicationDate'], message: 'Application date is required for this status' });

export const createApplicationResponseSchema = z.strictObject({ application: applicationSchema });
// Decoding and validating the cursor's timestamp/UUID tuple belongs to the list service.
export const applicationCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value === value.trim());
const listLimit = z.union([z.number(), z.string().regex(/^[1-9]\d?$/)
  .refine((value) => value === String(Number(value))).transform(Number)])
  .pipe(z.number().int().min(1).max(50));
export const listApplicationsQuerySchema = z.strictObject({
  limit: listLimit.default(20), cursor: applicationCursorSchema.optional()
});
export const listApplicationsResponseSchema = z.strictObject({
  items: z.array(applicationSchema).max(50), nextCursor: applicationCursorSchema.nullable()
});
const messages = z.array(z.string().max(200)).max(5);
export const applicationErrorResponseSchema = z.strictObject({
  code: z.enum(['INVALID_REQUEST', 'UNAUTHENTICATED', 'REQUEST_REJECTED', 'NOT_FOUND', 'RATE_LIMITED',
    'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'INVALID_JSON', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'INVALID_COOKIE']),
  message: z.string().max(200),
  fieldErrors: z.strictObject({ company: messages.optional(), jobTitle: messages.optional(), status: messages.optional(),
    applicationDate: messages.optional(), location: messages.optional(), jobUrl: messages.optional(), notes: messages.optional() }).optional()
});

export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type CreateApplicationInput = z.input<typeof createApplicationRequestSchema>;
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;
export type Application = z.infer<typeof applicationSchema>;
export type CreateApplicationResponse = z.infer<typeof createApplicationResponseSchema>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
export type ListApplicationsResponse = z.infer<typeof listApplicationsResponseSchema>;
export type ApplicationErrorResponse = z.infer<typeof applicationErrorResponseSchema>;
