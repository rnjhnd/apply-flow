import { applicationSchema, createApplicationRequestSchema, createApplicationResponseSchema,
  listApplicationsQuerySchema, listApplicationsResponseSchema, type ApplicationErrorResponse } from '@applyflow/contracts';
import type { Prisma, Session } from '../../generated/prisma/client.ts';
import { createSessionService, isSessionValid } from '../auth/sessions.js';
import { hashSessionToken, matchesCsrfToken } from '../auth/tokens.js';
import { createApplicationDatePolicy } from './date-policy.js';
import { ApplicationHttpError } from './http-error.js';
import { decodeApplicationCursor, encodeApplicationCursor } from './pagination.js';

export type ApplicationTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | 'session' | 'jobApplication'>;
export type ApplicationDatabase = {
  $transaction<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T>;
};
export type ApplicationProof = { token: string; csrfToken?: string | undefined };
const selection = { id: true, company: true, jobTitle: true, status: true, applicationDate: true,
  location: true, jobUrl: true, notes: true, createdAt: true, updatedAt: true } as const;
type PublicRow = Prisma.JobApplicationGetPayload<{ select: typeof selection }>;

function dto(row: PublicRow) {
  // Prisma's PostgreSQL DATE representation is UTC midnight, never browser/local time.
  if (row.applicationDate && (row.applicationDate.getUTCHours() !== 0 || row.applicationDate.getUTCMinutes() !== 0
    || row.applicationDate.getUTCSeconds() !== 0 || row.applicationDate.getUTCMilliseconds() !== 0)) throw new Error();
  return applicationSchema.parse({ id: row.id, company: row.company, jobTitle: row.jobTitle, status: row.status,
    applicationDate: row.applicationDate?.toISOString().slice(0, 10) ?? null, location: row.location,
    jobUrl: row.jobUrl, notes: row.notes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}

const unauthenticated = () => new ApplicationHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
export function createApplicationService(database: ApplicationDatabase, options: { now: () => Date; timeZone: string }) {
  const datePolicy = createApplicationDatePolicy(options);
  async function safely<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ApplicationHttpError) throw error;
      throw new ApplicationHttpError(503, 'SERVICE_UNAVAILABLE', 'Applications are temporarily unavailable.');
    }
  }
  async function owner(transaction: ApplicationTransaction, proof: ApplicationProof, write: boolean) {
    const rows = await transaction.$queryRaw<Session[]>`
      SELECT * FROM public."Session" WHERE "tokenHash" = ${hashSessionToken(proof.token)} FOR UPDATE
    `;
    const session = rows[0];
    if (!session?.userId || !isSessionValid(session, options.now())) throw unauthenticated();
    if (write && !matchesCsrfToken(session.csrfToken, proof.csrfToken)) {
      throw new ApplicationHttpError(403, 'REQUEST_REJECTED', 'Application request rejected.');
    }
    if (!await createSessionService(transaction, { now: options.now }).refreshAuthenticated(proof.token)) throw unauthenticated();
    return session.userId;
  }
  return {
    create(input: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const parsed = createApplicationRequestSchema.safeParse(input);
        if (!parsed.success) {
          const fieldErrors: NonNullable<ApplicationErrorResponse['fieldErrors']> = {};
          for (const key of ['company', 'jobTitle', 'status', 'applicationDate', 'location', 'jobUrl', 'notes'] as const) {
            if (parsed.error.issues.some(issue => issue.path[0] === key)) fieldErrors[key] = ['Review this field.'];
          }
          throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Review the application fields.', fieldErrors);
        }
        const policy = datePolicy(parsed.data.applicationDate);
        if (!policy.valid) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Review the application date.', { applicationDate: [policy.message] });
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, true);
          const value = parsed.data;
          const row = await transaction.jobApplication.create({ data: { userId, company: value.company, jobTitle: value.jobTitle,
            status: value.status, applicationDate: value.applicationDate === null ? null : new Date(`${value.applicationDate}T00:00:00.000Z`),
            location: value.location, jobUrl: value.jobUrl, notes: value.notes }, select: selection });
          return createApplicationResponseSchema.parse({ application: dto(row) });
        });
      });
    },
    list(input: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const parsed = listApplicationsQuerySchema.safeParse(input);
        if (!parsed.success) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application list query.');
        const { limit, cursor } = parsed.data;
        const boundary = cursor === undefined ? null : decodeApplicationCursor(cursor);
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, false);
          const rows = await transaction.jobApplication.findMany({ where: { userId, ...(boundary ? {
            OR: [{ createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } }]
          } : {}) }, select: selection, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
          const items = rows.slice(0, limit);
          return listApplicationsResponseSchema.parse({ items: items.map(dto), nextCursor: rows.length > limit
            ? encodeApplicationCursor(items[items.length - 1]!) : null });
        });
      });
    }
  };
}
export type ApplicationService = ReturnType<typeof createApplicationService>;
