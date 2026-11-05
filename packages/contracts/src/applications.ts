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

export const applicationIdSchema = z.uuid();
export const applicationVersionSchema = z.number().int().min(1).max(2_147_483_647);
export const applicationLifecycleRequestSchema = z.strictObject({ expectedVersion: applicationVersionSchema });
export const deleteApplicationRequestSchema = z.strictObject({
  expectedVersion: applicationVersionSchema, confirmPermanentDeletion: z.literal(true)
});
export const deleteApplicationResponseSchema = z.strictObject({ deletedApplicationId: applicationIdSchema });
export const applicationViewSchema = z.enum(['active', 'archived']);
export const applicationConflictReasonSchema = z.enum(['STALE_VERSION', 'APPLICATION_ARCHIVED', 'APPLICATION_NOT_ARCHIVED']);
// The input check makes every optional-value key required: omitted/undefined is
// different from an explicit null. Existing field normalization still applies.
const completeOptional = <T extends z.ZodType>(schema: T) => z.preprocess((value, context) => {
  if (value === undefined) {
    context.addIssue({ code: 'custom', message: 'Required' });
    return z.NEVER;
  }
  return value;
}, schema);
export const updateApplicationRequestSchema = z.strictObject({
  company: createFields.company, jobTitle: createFields.jobTitle, status: applicationStatusSchema,
  applicationDate: completeOptional(createFields.applicationDate),
  location: completeOptional(createFields.location), jobUrl: completeOptional(createFields.jobUrl),
  notes: completeOptional(createFields.notes), expectedVersion: applicationVersionSchema
}).refine(hasRequiredDate, { path: ['applicationDate'], message: 'Application date is required for this status' });

export const applicationSchema = z.strictObject({
  id: applicationIdSchema, version: applicationVersionSchema,
  company: canonicalText(160), jobTitle: canonicalText(200), status: applicationStatusSchema,
  applicationDate: applicationDateSchema.nullable(), location: canonicalText(200).nullable(),
  jobUrl: jobUrlSchema.nullable(), notes: text(4000).nullable(),
  createdAt: z.iso.datetime({ precision: 3 }), updatedAt: z.iso.datetime({ precision: 3 }),
  archivedAt: z.iso.datetime({ precision: 3 }).nullable()
}).refine(hasRequiredDate, { path: ['applicationDate'], message: 'Application date is required for this status' });

export const createApplicationResponseSchema = z.strictObject({ application: applicationSchema });
export const getApplicationResponseSchema = createApplicationResponseSchema;
export const updateApplicationResponseSchema = createApplicationResponseSchema;
// Decoding and validating the cursor's timestamp/UUID tuple belongs to the list service.
export const applicationCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value === value.trim());
const listLimit = z.union([z.number(), z.string().regex(/^[1-9]\d?$/)
  .refine((value) => value === String(Number(value))).transform(Number)])
  .pipe(z.number().int().min(1).max(50));
// Validate Unicode before trimming, then apply the limit to the normalized query.
// A blank search is equivalent to omitting q; internal whitespace stays literal.
const applicationSearch = text(Number.MAX_SAFE_INTEGER).transform(value => value.trim())
  .pipe(text(200)).transform(value => value || undefined);
export const listApplicationsQuerySchema = z.strictObject({
  limit: listLimit.default(20), cursor: applicationCursorSchema.optional(), view: applicationViewSchema.default('active'),
  q: applicationSearch.optional(), status: applicationStatusSchema.optional()
});
export const listApplicationsResponseSchema = z.strictObject({
  items: z.array(applicationSchema).max(50), nextCursor: applicationCursorSchema.nullable()
});
export const historyCursorSchema = z.string().regex(/^[1-9]\d{0,9}$/)
  .refine(value => value === String(Number(value)) && Number(value) <= 2_147_483_647);
export const listApplicationHistoryQuerySchema = z.strictObject({
  limit: listLimit.default(20), cursor: historyCursorSchema.optional()
});
export const applicationStatusHistorySchema = z.strictObject({
  id: z.uuid(), fromStatus: applicationStatusSchema, toStatus: applicationStatusSchema,
  applicationVersion: applicationVersionSchema.refine(value => value >= 2),
  changedAt: z.iso.datetime({ precision: 3 })
}).refine(value => value.fromStatus !== value.toStatus);
export const listApplicationHistoryResponseSchema = z.strictObject({
  items: z.array(applicationStatusHistorySchema).max(50), nextCursor: historyCursorSchema.nullable()
});
const messages = z.array(z.string().max(200)).max(5);
export const applicationErrorResponseSchema = z.strictObject({
  code: z.enum(['INVALID_REQUEST', 'UNAUTHENTICATED', 'REQUEST_REJECTED', 'NOT_FOUND', 'RATE_LIMITED',
    'APPLICATION_CONFLICT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'INVALID_JSON', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'INVALID_COOKIE']),
  message: z.string().max(200),
  conflictReason: applicationConflictReasonSchema.optional(),
  fieldErrors: z.strictObject({ company: messages.optional(), jobTitle: messages.optional(), status: messages.optional(),
    applicationDate: messages.optional(), location: messages.optional(), jobUrl: messages.optional(), notes: messages.optional() }).optional()
}).refine(value => value.conflictReason === undefined || value.code === 'APPLICATION_CONFLICT');

export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type ApplicationLifecycleRequest = z.infer<typeof applicationLifecycleRequestSchema>;
export type DeleteApplicationRequest = z.infer<typeof deleteApplicationRequestSchema>;
export type DeleteApplicationResponse = z.infer<typeof deleteApplicationResponseSchema>;
export type ApplicationView = z.infer<typeof applicationViewSchema>;
export type ApplicationConflictReason = z.infer<typeof applicationConflictReasonSchema>;
export type CreateApplicationInput = z.input<typeof createApplicationRequestSchema>;
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;
export type Application = z.infer<typeof applicationSchema>;
export type CreateApplicationResponse = z.infer<typeof createApplicationResponseSchema>;
export type UpdateApplicationRequest = z.infer<typeof updateApplicationRequestSchema>;
export type GetApplicationResponse = z.infer<typeof getApplicationResponseSchema>;
export type UpdateApplicationResponse = z.infer<typeof updateApplicationResponseSchema>;
export type ApplicationStatusHistory = z.infer<typeof applicationStatusHistorySchema>;
export type ListApplicationHistoryQuery = z.infer<typeof listApplicationHistoryQuerySchema>;
export type ListApplicationHistoryResponse = z.infer<typeof listApplicationHistoryResponseSchema>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
export type ListApplicationsResponse = z.infer<typeof listApplicationsResponseSchema>;
export type ApplicationErrorResponse = z.infer<typeof applicationErrorResponseSchema>;
