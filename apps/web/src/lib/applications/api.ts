import { applicationErrorResponseSchema, createApplicationRequestSchema, createApplicationResponseSchema,
  listApplicationsQuerySchema, listApplicationsResponseSchema, applicationIdSchema, getApplicationResponseSchema,
  updateApplicationRequestSchema, updateApplicationResponseSchema, listApplicationHistoryQuerySchema,
  listApplicationHistoryResponseSchema, type ApplicationErrorResponse } from '@applyflow/contracts';
import { AuthFailure, retryAfter } from '../auth/api';
import type { AuthStore } from '../auth/store';

export class ApplicationFailure extends Error {
  constructor(readonly kind: 'validation' | 'http' | 'unknown' | 'stale', readonly status = 0,
    readonly fields: ApplicationErrorResponse['fieldErrors'] = undefined, readonly retryAt: number | null = null,
    readonly code?: ApplicationErrorResponse['code']) {
    super('The application request could not be completed.'); this.name = 'ApplicationFailure';
  }
}

export function createApplicationsApi(store: AuthStore, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let cooldownUntil: number | null = null;
  function admit() {
    if (cooldownUntil !== null && cooldownUntil > now()) throw new ApplicationFailure('http', 429, undefined, cooldownUntil);
  }
  async function request<T>(url: string, schema: { parse(value: unknown): T }, input?: { body: unknown; proof: string; method?: 'PUT' }, signal?: AbortSignal) {
    admit();
    let response: Response;
    try { response = await fetcher(url, { method: input ? input.method ?? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'X-ApplyFlow-Request': '1', ...(input ? { 'Content-Type': 'application/json', 'X-CSRF-Token': input.proof } : {}) },
      ...(input ? { body: JSON.stringify(input.body) } : {}), ...(signal ? { signal } : {}) }); }
    catch { throw new ApplicationFailure('unknown'); }
    const retryAt = response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : null;
    if (retryAt !== null) cooldownUntil = Math.max(cooldownUntil ?? 0, retryAt);
    let body: unknown;
    try { if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error(); body = await response.json(); }
    catch { throw new ApplicationFailure('unknown', response.status, undefined, retryAt); }
    if (!response.ok) {
      const parsed = applicationErrorResponseSchema.safeParse(body);
      if (!parsed.success) throw new ApplicationFailure('unknown', response.status, undefined, retryAt);
      // Never retain arbitrary response messages, exception bodies or input echoes.
      const fields = parsed.data.fieldErrors ? Object.fromEntries(Object.keys(parsed.data.fieldErrors).map(key => [key, ['Review this field.']])) : undefined;
      throw new ApplicationFailure(response.status >= 500 ? 'unknown' : 'http', response.status, fields, retryAt, parsed.data.code);
    }
    try { if (response.status !== (input && input.method !== 'PUT' ? 201 : 200)) throw new Error(); return schema.parse(body); }
    catch { throw new ApplicationFailure('unknown', response.status); }
  }
  function id(value: unknown) {
    const parsed = applicationIdSchema.safeParse(value);
    if (!parsed.success) throw new ApplicationFailure('validation');
    return parsed.data;
  }
  async function read<T>(send: () => Promise<T>, signal?: AbortSignal) {
    admit();
    try { return await store.authenticatedRequest(send, signal); }
    catch (error) {
      if (error instanceof ApplicationFailure) throw error;
      if (error instanceof AuthFailure && error.kind === 'cooldown') throw new ApplicationFailure('http', 429, undefined, error.retryAt);
      throw new ApplicationFailure('stale');
    }
  }
  return {
    async get(value: unknown, signal?: AbortSignal) {
      const key = id(value);
      return read(async () => {
        const result = await request(`/api/applications/${key}`, getApplicationResponseSchema, undefined, signal);
        if (result.application.id !== key) throw new ApplicationFailure('unknown');
        return result;
      }, signal);
    },
    async update(value: unknown, input: unknown) {
      const key = id(value), parsed = updateApplicationRequestSchema.safeParse(input);
      if (!parsed.success) throw new ApplicationFailure('validation');
      admit();
      let dispatched = false;
      try { return await store.authenticatedRequest(async proof => {
        dispatched = true;
        const result = await request(`/api/applications/${key}`, updateApplicationResponseSchema, { body: parsed.data, proof, method: 'PUT' });
        if (result.application.id !== key) throw new ApplicationFailure('unknown');
        return result;
      }); }
      catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (error instanceof AuthFailure && error.kind === 'cooldown') throw new ApplicationFailure('http', 429, undefined, error.retryAt);
        throw new ApplicationFailure(dispatched ? 'unknown' : 'stale');
      }
    },
    async history(value: unknown, input: unknown = {}, signal?: AbortSignal) {
      const key = id(value), parsed = listApplicationHistoryQuerySchema.safeParse(input);
      if (!parsed.success) throw new ApplicationFailure('validation');
      const query = new URLSearchParams({ limit: String(parsed.data.limit) });
      if (parsed.data.cursor) query.set('cursor', parsed.data.cursor);
      return read(async () => {
        const result = await request(`/api/applications/${key}/history?${query}`, listApplicationHistoryResponseSchema, undefined, signal);
        let previous = parsed.data.cursor ? Number(parsed.data.cursor) : Infinity;
        const ids = new Set<string>();
        for (const item of result.items) {
          if (item.applicationVersion >= previous || ids.has(item.id)) throw new ApplicationFailure('unknown');
          previous = item.applicationVersion; ids.add(item.id);
        }
        if (result.items.length > parsed.data.limit || (result.nextCursor !== null
          && result.nextCursor !== String(result.items.at(-1)?.applicationVersion))) throw new ApplicationFailure('unknown');
        return result;
      }, signal);
    },
    async create(input: unknown) {
      const parsed = createApplicationRequestSchema.safeParse(input);
      if (!parsed.success) throw new ApplicationFailure('validation');
      admit();
      let dispatched = false;
      try { return await store.authenticatedRequest(proof => { dispatched = true;
        return request('/api/applications', createApplicationResponseSchema, { body: parsed.data, proof }); }); }
      catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (error instanceof AuthFailure && error.kind === 'cooldown') throw new ApplicationFailure('http', 429, undefined, error.retryAt);
        throw new ApplicationFailure(dispatched ? 'unknown' : 'stale');
      }
    },
    async list(input: unknown = {}, signal?: AbortSignal) {
      admit();
      const parsed = listApplicationsQuerySchema.safeParse(input);
      if (!parsed.success) throw new ApplicationFailure('validation');
      const query = new URLSearchParams({ limit: String(parsed.data.limit) });
      if (parsed.data.cursor) query.set('cursor', parsed.data.cursor);
      try {
        // The same lock covers authoritative session verification and the GET.
        // Missed broadcasts cannot let another tab's cookie change select a
        // different owner between verification and request settlement.
        return await store.authenticatedRequest(() => request(`/api/applications?${query}`, listApplicationsResponseSchema, undefined, signal), signal);
      } catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (error instanceof AuthFailure && error.kind === 'cooldown') throw new ApplicationFailure('http', 429, undefined, error.retryAt);
        throw new ApplicationFailure('stale');
      }
    }
  };
}
export type ApplicationsApi = ReturnType<typeof createApplicationsApi>;
