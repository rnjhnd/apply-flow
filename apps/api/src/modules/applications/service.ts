import { applicationSchema, createApplicationRequestSchema, createApplicationResponseSchema,
  listApplicationsQuerySchema, listApplicationsResponseSchema, applicationIdSchema,
  getApplicationResponseSchema, updateApplicationRequestSchema, updateApplicationResponseSchema,
  listApplicationHistoryQuerySchema, listApplicationHistoryResponseSchema,
  applicationLifecycleRequestSchema, deleteApplicationRequestSchema, deleteApplicationResponseSchema,
  type ApplicationErrorResponse } from '@applyflow/contracts';
import type { Prisma, Session } from '../../generated/prisma/client.ts';
import { createSessionService, isSessionValid } from '../auth/sessions.js';
import { hashSessionToken, matchesCsrfToken } from '../auth/tokens.js';
import { createApplicationDatePolicy } from './date-policy.js';
import { ApplicationHttpError } from './http-error.js';
import { decodeApplicationCursor, encodeApplicationCursor } from './pagination.js';

export type ApplicationTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | 'session' | 'jobApplication' | 'applicationStatusHistory'>;
export type ApplicationDatabase = {
  $transaction<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T>;
};
export type ApplicationProof = { token: string; csrfToken?: string | undefined };
const selection = { id: true, company: true, jobTitle: true, status: true, applicationDate: true,
  location: true, jobUrl: true, notes: true, createdAt: true, updatedAt: true, version: true, archivedAt: true } as const;
type PublicRow = Prisma.JobApplicationGetPayload<{ select: typeof selection }>;

function dto(row: PublicRow) {
  // Prisma's PostgreSQL DATE representation is UTC midnight, never browser/local time.
  if (row.applicationDate && (row.applicationDate.getUTCHours() !== 0 || row.applicationDate.getUTCMinutes() !== 0
    || row.applicationDate.getUTCSeconds() !== 0 || row.applicationDate.getUTCMilliseconds() !== 0)) throw new Error();
  return applicationSchema.parse({ id: row.id, version: row.version, company: row.company, jobTitle: row.jobTitle, status: row.status,
    applicationDate: row.applicationDate?.toISOString().slice(0, 10) ?? null, location: row.location,
    jobUrl: row.jobUrl, notes: row.notes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString() });
}

const unauthenticated = () => new ApplicationHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
const notFound = () => new ApplicationHttpError(404, 'NOT_FOUND', 'Application not found.');
function applicationId(input: unknown) {
  const parsed = applicationIdSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid application ID.');
  return parsed.data.toLowerCase();
}
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
  async function lockOwned(transaction: ApplicationTransaction, key: string, userId: string) {
    // All mutations lock Session first, then only the authenticated owner's row.
    const rows = await transaction.$queryRaw<PublicRow[]>`
      SELECT id, company, "jobTitle", status, "applicationDate", location, "jobUrl", notes,
        "createdAt", "updatedAt", version, "archivedAt" FROM public."JobApplication"
      WHERE id = ${key}::uuid AND "userId" = ${userId}::uuid FOR UPDATE
    `;
    if (!rows[0]) throw notFound();
    return rows[0];
  }
  function requireVersion(row: PublicRow, expectedVersion: number) {
    if (row.version !== expectedVersion) {
      throw new ApplicationHttpError(409, 'APPLICATION_CONFLICT',
        'Application changed. Reload it and review your changes before trying again.', undefined, 'STALE_VERSION');
    }
  }
  function requireNextVersion(row: PublicRow) {
    if (row.version === 2_147_483_647) throw new Error('Application revision exhausted.');
  }
  function changeArchive(id: unknown, input: unknown, proof: ApplicationProof, archived: boolean) {
    return safely(async () => {
      const key = applicationId(id);
      const parsed = applicationLifecycleRequestSchema.safeParse(input);
      if (!parsed.success) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'A valid expected version is required.');
      return database.$transaction(async transaction => {
        const userId = await owner(transaction, proof, true);
        const previous = await lockOwned(transaction, key, userId);
        requireVersion(previous, parsed.data.expectedVersion);
        if ((previous.archivedAt !== null) === archived) {
          return updateApplicationResponseSchema.parse({ application: dto(previous) });
        }
        requireNextVersion(previous);
        const now = options.now();
        const archivedAt = archived ? now : null;
        const row = await transaction.jobApplication.update({ where: { id: key, userId }, data: {
          archivedAt, version: previous.version + 1, updatedAt: now
        }, select: selection });
        if (row.id !== key || row.version !== previous.version + 1 || row.archivedAt?.getTime() !== archivedAt?.getTime()) {
          throw new Error('Unexpected lifecycle response.');
        }
        return updateApplicationResponseSchema.parse({ application: dto(row) });
      });
    });
  }
  return {
    archive: (id: unknown, input: unknown, proof: ApplicationProof) => changeArchive(id, input, proof, true),
    restore: (id: unknown, input: unknown, proof: ApplicationProof) => changeArchive(id, input, proof, false),
    delete(id: unknown, input: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const key = applicationId(id);
        const parsed = deleteApplicationRequestSchema.safeParse(input);
        if (!parsed.success) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'A valid expected version and deletion confirmation are required.');
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, true);
          const previous = await lockOwned(transaction, key, userId);
          requireVersion(previous, parsed.data.expectedVersion);
          if (previous.archivedAt === null) {
            throw new ApplicationHttpError(409, 'APPLICATION_CONFLICT', 'Archive this application before permanently deleting it.',
              undefined, 'APPLICATION_NOT_ARCHIVED');
          }
          // Retain ON DELETE RESTRICT: remove only this owned parent's children
          // before the unique parent delete, within the same transaction.
          await transaction.applicationStatusHistory.deleteMany({ where: { applicationId: key, application: { userId } } });
          const row = await transaction.jobApplication.delete({ where: {
            id: key, userId, version: parsed.data.expectedVersion, archivedAt: { not: null }
          }, select: { id: true } });
          const response = deleteApplicationResponseSchema.parse({ deletedApplicationId: row.id });
          if (response.deletedApplicationId !== key) throw new Error('Unexpected deletion response.');
          return response;
        });
      });
    },
    get(id: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const key = applicationId(id);
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, false);
          const row = await transaction.jobApplication.findFirst({ where: { id: key, userId }, select: selection });
          if (!row) throw notFound();
          return getApplicationResponseSchema.parse({ application: dto(row) });
        });
      });
    },
    update(id: unknown, input: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const key = applicationId(id);
        const parsed = updateApplicationRequestSchema.safeParse(input);
        if (!parsed.success) {
          const fieldErrors: NonNullable<ApplicationErrorResponse['fieldErrors']> = {};
          for (const field of ['company', 'jobTitle', 'status', 'applicationDate', 'location', 'jobUrl', 'notes'] as const) {
            if (parsed.error.issues.some(issue => issue.path[0] === field)) fieldErrors[field] = ['Review this field.'];
          }
          throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Review the application fields.', fieldErrors);
        }
        const value = parsed.data;
        const policy = datePolicy(value.applicationDate);
        if (!policy.valid) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Review the application date.', { applicationDate: [policy.message] });
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, true);
          const previous = await lockOwned(transaction, key, userId);
          requireVersion(previous, value.expectedVersion);
          if (previous.archivedAt !== null) {
            throw new ApplicationHttpError(409, 'APPLICATION_CONFLICT', 'Restore this application before editing it.',
              undefined, 'APPLICATION_ARCHIVED');
          }
          const current = dto(previous);
          const fields = ['company', 'jobTitle', 'status', 'applicationDate', 'location', 'jobUrl', 'notes'] as const;
          if (fields.every(field => current[field] === value[field])) {
            return updateApplicationResponseSchema.parse({ application: current });
          }
          // Do not overflow PostgreSQL INTEGER or manufacture a wrapped revision.
          requireNextVersion(previous);
          const row = await transaction.jobApplication.update({ where: { id: key, userId }, data: {
            company: value.company, jobTitle: value.jobTitle, status: value.status,
            applicationDate: value.applicationDate === null ? null : new Date(`${value.applicationDate}T00:00:00.000Z`),
            location: value.location, jobUrl: value.jobUrl, notes: value.notes,
            version: previous.version + 1, updatedAt: options.now()
          }, select: selection });
          if (row.version !== previous.version + 1) throw new Error('Unexpected application revision.');
          if (previous.status !== value.status) {
            await transaction.applicationStatusHistory.create({ data: {
              applicationId: key, fromStatus: previous.status, toStatus: value.status,
              applicationVersion: row.version
            } });
          }
          return updateApplicationResponseSchema.parse({ application: dto(row) });
        });
      });
    },
    history(id: unknown, input: unknown, proof: ApplicationProof) {
      return safely(async () => {
        const key = applicationId(id);
        const parsed = listApplicationHistoryQuerySchema.safeParse(input);
        if (!parsed.success) throw new ApplicationHttpError(400, 'INVALID_REQUEST', 'Invalid history query.');
        const { limit, cursor } = parsed.data;
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, false);
          const parent = await transaction.jobApplication.findFirst({ where: { id: key, userId }, select: { id: true } });
          if (!parent) throw notFound();
          const rows = await transaction.applicationStatusHistory.findMany({ where: {
            applicationId: key, application: { userId },
            ...(cursor === undefined ? {} : { applicationVersion: { lt: Number(cursor) } })
          }, orderBy: { applicationVersion: 'desc' }, take: limit + 1,
          select: { id: true, fromStatus: true, toStatus: true, applicationVersion: true, changedAt: true } });
          const items = rows.slice(0, limit);
          return listApplicationHistoryResponseSchema.parse({ items: items.map(row => ({
            id: row.id, fromStatus: row.fromStatus, toStatus: row.toStatus,
            applicationVersion: row.applicationVersion, changedAt: row.changedAt.toISOString()
          })), nextCursor: rows.length > limit ? String(items[items.length - 1]!.applicationVersion) : null });
        });
      });
    },
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
        const { limit, cursor, view } = parsed.data;
        const boundary = cursor === undefined ? null : decodeApplicationCursor(cursor);
        return database.$transaction(async transaction => {
          const userId = await owner(transaction, proof, false);
          const rows = await transaction.jobApplication.findMany({ where: { userId, archivedAt: view === 'active' ? null : { not: null }, ...(boundary ? {
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
