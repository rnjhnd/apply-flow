import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { JobApplication, Session, ApplicationStatusHistory } from '../../generated/prisma/client.ts';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';
import { hashSessionToken } from '../auth/tokens.js';
import { createApplicationService, type ApplicationTransaction } from './service.js';
import { encodeApplicationCursor } from './pagination.js';

const id = 'c4974360-a70c-4a29-8b41-df95d15d7270';
const userId = 'fe97bd36-272f-4da9-bba5-61eea12ccf3e';
const foreignId = 'b4974360-a70c-4a29-8b41-df95d15d7270';
const siblingId = 'a4974360-a70c-4a29-8b41-df95d15d7270';
const now = new Date('2026-10-22T12:00:00.000Z'), before = new Date('2026-10-22T11:00:00.000Z');
const proof = { token: 'a'.repeat(64), csrfToken: 'b'.repeat(64) };
const secondProof = { token: 'd'.repeat(64), csrfToken: 'e'.repeat(64) };
const edit = { company: 'Acme', jobTitle: 'Engineer', status: 'APPLIED', applicationDate: '2024-02-29',
  location: 'Manila', jobUrl: 'https://example.invalid/job', notes: 'Keep\n private details', expectedVersion: 5 };
type State = { apps: JobApplication[]; sessions: Session[]; events: ApplicationStatusHistory[] };
type ListWhere = { userId: string; archivedAt: null | { not: null };
  OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }> };

// Local staged-state double only. Serialization establishes deterministic service
// ordering, not evidence of PostgreSQL row locks, FK enforcement or COMMIT behavior.
function fixture(archived = false, historyCount = 1) {
  const row: JobApplication = { id, userId, version: 5, company: edit.company, jobTitle: edit.jobTitle,
    status: 'APPLIED', applicationDate: new Date('2024-02-29T00:00:00.000Z'), location: edit.location,
    jobUrl: edit.jobUrl, notes: edit.notes, createdAt: before, updatedAt: before, archivedAt: archived ? before : null };
  let state: State = { apps: [row, { ...row, id: foreignId, userId: foreignId }, { ...row, id: siblingId }],
    sessions: [proof, secondProof].map((p, index) => ({ id: index ? siblingId : id, userId,
      tokenHash: hashSessionToken(p.token), csrfToken: p.csrfToken, createdAt: before,
      lastSeenAt: before, expiresAt: new Date('2026-10-23T12:00:00.000Z') })),
    events: [id, foreignId, siblingId].flatMap(applicationId => Array.from({ length: historyCount }, (_, i) => ({
      id: randomUUID(), applicationId, fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: i + 2, changedAt: before
    }))) };
  const faults = { historyDelete: false, delete: false, response: false, wrongId: false, commit: false, refresh: false, updateResponse: false };
  const calls: Array<{ text: string; values: unknown[] }> = [], trace: string[] = [];
  const update = vi.fn(), remove = vi.fn(), removeHistory = vi.fn(), insertHistory = vi.fn(), list = vi.fn();
  let queue = Promise.resolve(), hold: (() => Promise<void>) | undefined;
  const database = { $transaction: async <T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T> => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    const staged = structuredClone(state);
    try {
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('?'); calls.push({ text, values });
          if (text.includes('FROM public."Session"')) { trace.push('session lock'); return staged.sessions.filter(s => s.tokenHash === values[0]); }
          if (text.includes('UPDATE public."Session"')) {
            trace.push('session refresh'); const s = staged.sessions.find(s => s.tokenHash === values[1]);
            if (!s || faults.refresh) return []; s.lastSeenAt = values[0] as Date; return [s];
          }
          if (text.includes('FROM public."JobApplication"')) {
            trace.push('application lock'); await hold?.();
            return staged.apps.filter(a => a.id === values[0] && a.userId === values[1]).map(a => structuredClone(a));
          }
          throw new Error('Unexpected local double SQL');
        },
        jobApplication: {
          findFirst: async ({ where }: { where: { id: string; userId: string } }) => staged.apps.find(a => a.id === where.id && a.userId === where.userId) ?? null,
          findMany: list.mockImplementation(async ({ where, take }: { where: ListWhere; take: number }) => staged.apps.filter(a =>
            a.userId === where.userId && (where.archivedAt === null ? a.archivedAt === null : a.archivedAt !== null)
            && (!where.OR || where.OR.some(p => (p.createdAt instanceof Date ? a.createdAt.getTime() === p.createdAt.getTime()
              : a.createdAt < p.createdAt.lt) && (!p.id || a.id < p.id.lt))))
            .sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, take)),
          update: update.mockImplementation(async ({ where, data }: { where: { id: string; userId: string }; data: Partial<JobApplication> }) => {
            trace.push('application update'); const a = staged.apps.find(a => a.id === where.id && a.userId === where.userId);
            if (!a) throw new Error('Unique update missing'); Object.assign(a, data);
            return { ...a, ...(faults.updateResponse ? { notes: 'x'.repeat(4001) } : {}) };
          }),
          delete: remove.mockImplementation(async ({ where }: { where: { id: string; userId: string; version: number; archivedAt: { not: null } } }) => {
            trace.push('application delete'); if (faults.delete) throw new Error('private database password=SECRET');
            const a = staged.apps.find(a => a.id === where.id && a.userId === where.userId && a.version === where.version && a.archivedAt !== null);
            if (!a || where.archivedAt.not !== null || staged.events.some(h => h.applicationId === a.id)) throw new Error('Restricted unique delete');
            staged.apps = staged.apps.filter(r => r !== a);
            return { id: faults.response ? 'invalid-id' : faults.wrongId ? foreignId : a.id };
          })
        },
        applicationStatusHistory: {
          deleteMany: removeHistory.mockImplementation(async ({ where }: { where: { applicationId: string; application: { userId: string } } }) => {
            trace.push('history delete'); if (faults.historyDelete) throw new Error('private history secret=SECRET');
            const owned = staged.apps.some(a => a.id === where.applicationId && a.userId === where.application.userId);
            const count = staged.events.filter(h => owned && h.applicationId === where.applicationId).length;
            staged.events = staged.events.filter(h => !(owned && h.applicationId === where.applicationId)); return { count };
          }),
          create: insertHistory.mockImplementation(async ({ data }: { data: Omit<ApplicationStatusHistory, 'id' | 'changedAt'> }) => {
            const event = { ...data, id: randomUUID(), changedAt: now }; staged.events.push(event); return event;
          }),
          findMany: async ({ where, take }: { where: { applicationId: string; application: { userId: string }; applicationVersion?: { lt: number } }; take: number }) =>
            staged.events.filter(h => h.applicationId === where.applicationId
              && staged.apps.some(a => a.id === h.applicationId && a.userId === where.application.userId)
              && (!where.applicationVersion || h.applicationVersion < where.applicationVersion.lt))
              .sort((a,b) => b.applicationVersion - a.applicationVersion).slice(0, take)
        }
      } as unknown as ApplicationTransaction;
      const result = await work(tx); if (faults.commit) throw new Error('private commit secret=SECRET');
      state = staged; return result;
    } finally { release(); }
  } };
  vi.spyOn(database, '$transaction');
  return { service: createApplicationService(database, { now: () => now, timeZone: 'Asia/Manila' }), database,
    read: () => structuredClone(state), change: (work: (s: State) => void) => work(state),
    hold: (work: () => Promise<void>) => { hold = work; }, faults, calls, trace, update, remove, removeHistory, insertHistory, list };
}
type Fixture = ReturnType<typeof fixture>;
const operations = ['archive','restore','delete'] as const;
const deletion = { expectedVersion: 5, confirmPermanentDeletion: true };
const payload = (operation: typeof operations[number]) => operation === 'delete' ? deletion : { expectedVersion: 5 };
function http(f: Fixture) {
  return createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }),
    sessions: { findValid: vi.fn(), createAnonymous: vi.fn() } }, { applications: f.service });
}
const headers = { Origin: 'http://127.0.0.1:5173', 'X-ApplyFlow-Request': '1',
  Cookie: 'applyflow_session=' + proof.token, 'X-CSRF-Token': proof.csrfToken };
const path = '/api/applications/' + id;

describe('owner-scoped lifecycle transactions (offline doubles)', () => {
  it('accepts UUID casing consistently with PostgreSQL and returns the canonical deleted ID', async () => {
    const f=fixture();await f.service.archive(id.toUpperCase(),{expectedVersion:5},proof);
    await expect(f.service.delete(id.toUpperCase(),{...deletion,expectedVersion:6},proof)).resolves.toEqual({deletedApplicationId:id});
  });
  it.each(['archive','restore'] as const)('%s increments once and preserves every other application field and history', async operation => {
    const f = fixture(operation === 'restore', 3), old = f.read();
    const result = await f.service[operation](id, { expectedVersion: 5 }, proof);
    expect(f.read().apps[0]).toEqual({ ...old.apps[0], archivedAt: operation === 'archive' ? now : null, version: 6, updatedAt: now });
    expect(result.application).toMatchObject({ version: 6, archivedAt: operation === 'archive' ? now.toISOString() : null });
    expect(result.application).not.toHaveProperty('userId'); expect(result.application).not.toHaveProperty('statusHistory');
    expect(f.read().events).toEqual(old.events); expect(f.insertHistory).not.toHaveBeenCalled(); expect(f.removeHistory).not.toHaveBeenCalled();
    expect(Object.keys(f.update.mock.calls[0]![0].data).sort()).toEqual(['archivedAt','updatedAt','version']);
    expect(f.trace).toEqual(['session lock','session refresh','application lock','application update']);
    expect(f.calls[0]!.text).toContain('FOR UPDATE'); expect(f.calls[2]!.text).toContain('FOR UPDATE');
    expect(f.calls[2]).toMatchObject({ text: expect.stringContaining('AND "userId" ='), values: [id,userId] });
  });
  it.each(['archive','restore'] as const)('%s no-op preserves archive time, version and updatedAt, including maximum version', async operation => {
    const f = fixture(operation === 'archive'); f.change(s => { s.apps[0]!.version = 2_147_483_647; }); const old = f.read();
    const result = await f.service[operation](id, { expectedVersion: 2_147_483_647 }, proof);
    expect(f.read().apps).toEqual(old.apps); expect(f.read().events).toEqual(old.events);
    expect(result.application.version).toBe(2_147_483_647); expect(f.update).not.toHaveBeenCalled();
  });
  it.each(operations)('%s checks version before no-op or state eligibility and rolls back activity', async operation => {
    const f = fixture(operation === 'archive'); f.change(s => { s.apps[0]!.version = 6; }); const old = f.read();
    await expect(f.service[operation](id, payload(operation), proof)).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CONFLICT', conflictReason: 'STALE_VERSION' });
    expect(f.read()).toEqual(old); expect(f.update).not.toHaveBeenCalled(); expect(f.removeHistory).not.toHaveBeenCalled();
  });
  it('rejects archived editing, including no-op edits, after the version comparison', async () => {
    const f = fixture(true), old = f.read();
    await expect(f.service.update(id, { ...edit, expectedVersion: 4 }, proof)).rejects.toMatchObject({ conflictReason: 'STALE_VERSION' });
    await expect(f.service.update(id, edit, proof)).rejects.toMatchObject({ status: 409, conflictReason: 'APPLICATION_ARCHIVED' });
    expect(f.read()).toEqual(old); expect(f.update).not.toHaveBeenCalled();
  });
  it('rejects active deletion without touching history or committing session activity', async () => {
    const f = fixture(), old = f.read();
    await expect(f.service.delete(id, deletion, proof)).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CONFLICT', conflictReason: 'APPLICATION_NOT_ARCHIVED' });
    expect(f.read()).toEqual(old); expect(f.removeHistory).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it.each([0,1,4])('deletes only the archived owned parent and its %i history entries', async count => {
    const f = fixture(true,count), old = f.read();
    expect(await f.service.delete(id, deletion, proof)).toEqual({ deletedApplicationId: id });
    expect(f.read().apps).toEqual(old.apps.filter(a => a.id !== id));
    expect(f.read().events).toEqual(old.events.filter(h => h.applicationId !== id));
    expect(f.removeHistory).toHaveBeenCalledExactlyOnceWith({ where: { applicationId: id, application: { userId } } });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith({ where: { id,userId,version:5,archivedAt:{not:null} },select:{id:true} });
    expect(f.trace).toEqual(['session lock','session refresh','application lock','history delete','application delete']);
    await expect(f.service.delete(id, deletion, proof)).rejects.toMatchObject({ status:404,code:'NOT_FOUND' });
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it('does not require another revision to delete an archived application at the maximum version', async () => {
    const f = fixture(true); f.change(s => { s.apps[0]!.version=2_147_483_647; });
    await expect(f.service.delete(id,{...deletion,expectedVersion:2_147_483_647},proof)).resolves.toEqual({deletedApplicationId:id});
  });
  it.each(['archive','restore'] as const)('%s fails atomically on substantive version exhaustion', async operation => {
    const f=fixture(operation==='restore'); f.change(s=>{s.apps[0]!.version=2_147_483_647;}); const old=f.read();
    await expect(f.service[operation](id,{expectedVersion:2_147_483_647},proof)).rejects.toMatchObject({status:503});
    expect(f.read()).toEqual(old);expect(f.update).not.toHaveBeenCalled();expect(f.database.$transaction).toHaveBeenCalledOnce();
  });
  it.each(['historyDelete','delete','response','wrongId','commit'] as const)('rolls back parent/history/session state on deletion %s failure, without retry',async fault=>{
    const f=fixture(true,3); f.faults[fault]=true; const old=f.read();
    const error=await f.service.delete(id,deletion,proof).catch(e=>e);
    expect(error).toMatchObject({status:503,code:'SERVICE_UNAVAILABLE'});expect(String(error)).not.toContain('SECRET');
    expect(f.read()).toEqual(old);expect(f.database.$transaction).toHaveBeenCalledOnce();expect(f.removeHistory).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledTimes(fault==='historyDelete'?0:1);
  });
  it.each(['archive','restore'] as const)('rolls back %s and session refresh when public response validation fails',async operation=>{
    const f=fixture(operation==='restore');f.faults.updateResponse=true;const old=f.read();
    await expect(f.service[operation](id,{expectedVersion:5},proof)).rejects.toMatchObject({status:503});
    expect(f.read()).toEqual(old);expect(f.database.$transaction).toHaveBeenCalledOnce();
  });
  it.each(['archive','restore'] as const)('does not retry an uncertain %s commit',async operation=>{
    const f=fixture(operation==='restore');f.faults.commit=true;const old=f.read();
    await expect(f.service[operation](id,{expectedVersion:5},proof)).rejects.toMatchObject({status:503,code:'SERVICE_UNAVAILABLE'});
    expect(f.database.$transaction).toHaveBeenCalledOnce();expect(f.update).toHaveBeenCalledOnce();expect(f.read()).toEqual(old);
  });
  it.each(['SAVED','APPLIED','ASSESSMENT','INTERVIEW','OFFER','REJECTED','WITHDRAWN'] as const)('preserves %s status and its date through archive/restore',async status=>{
    const f=fixture();f.change(s=>{s.apps[0]!.status=status;if(status==='SAVED')s.apps[0]!.applicationDate=null;});
    const original=f.read().apps[0]!;
    await f.service.archive(id,{expectedVersion:5},proof);await f.service.restore(id,{expectedVersion:6},proof);
    expect(f.read().apps[0]).toEqual({...original,version:7,updatedAt:now});expect(f.insertHistory).not.toHaveBeenCalled();
  });
  it('preserves status/history through archive and restore, leaving a truthful revision gap on the next status change',async()=>{
    const f=fixture();const old=f.read().events;
    await f.service.archive(id,{expectedVersion:5},proof);await f.service.restore(id,{expectedVersion:6},proof);
    expect(f.read().events).toEqual(old);
    await f.service.update(id,{...edit,status:'INTERVIEW',expectedVersion:7},proof);
    expect(f.read().events.at(-1)).toMatchObject({fromStatus:'APPLIED',toStatus:'INTERVIEW',applicationVersion:8});
  });
  it.each(operations)('%s returns indistinguishable missing/foreign 404s without private lifecycle reasons',async operation=>{
    const f=fixture(true),old=f.read();
    for(const key of [foreignId,randomUUID()]){
      const error=await f.service[operation](key,payload(operation),proof).catch(e=>e);
      expect(error).toMatchObject({status:404,code:'NOT_FOUND',message:'Application not found.'});expect(error.conflictReason).toBeUndefined();
    }
    expect(f.read()).toEqual(old);expect(f.removeHistory).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();
  });
  it.each(operations.flatMap(operation=>['missing','anonymous','expired','refresh'].map(kind=>({operation,kind}))))('rejects $operation with $kind session before application locking',async({operation,kind})=>{
    const f=fixture(true);f.change(s=>{if(kind==='missing')s.sessions=[];if(kind==='anonymous')s.sessions[0]!.userId=null;if(kind==='expired')s.sessions[0]!.expiresAt=now;});
    if(kind==='refresh')f.faults.refresh=true;const old=f.read();
    await expect(f.service[operation](id,payload(operation),proof)).rejects.toMatchObject({status:401});
    expect(f.read()).toEqual(old);expect(f.calls.some(c=>c.text.includes('FROM public."JobApplication"'))).toBe(false);
  });
  it.each(operations.flatMap(operation=>[undefined,'wrong','f'.repeat(64)].map(csrfToken=>({operation,csrfToken}))))('rejects $operation CSRF %# before application access',async({operation,csrfToken})=>{
    const f=fixture(true),old=f.read();
    await expect(f.service[operation](id,payload(operation),{token:proof.token,csrfToken})).rejects.toMatchObject({status:403});
    expect(f.calls).toHaveLength(1);expect(f.read()).toEqual(old);
  });
  it.each(operations)('%s rejects malformed IDs, versions and overrides before constructing a transaction',async operation=>{
    const f=fixture(true);
    for(const badId of ['bad','',null,['bad']])await expect(f.service[operation](badId,payload(operation),proof)).rejects.toMatchObject({status:400});
    for(const body of [{},{...payload(operation),expectedVersion:'5'},{...payload(operation),userId},{...payload(operation),archivedAt:now.toISOString()}]){
      await expect(f.service[operation](id,body,proof)).rejects.toMatchObject({status:400});
    }
    if(operation==='delete')await expect(f.service.delete(id,{expectedVersion:5,confirmPermanentDeletion:false},proof)).rejects.toMatchObject({status:400});
    expect(f.database.$transaction).not.toHaveBeenCalled();
  });
});

describe('lifecycle reads, pagination and HTTP admission (offline)',()=>{
  it('returns archived details and history without allowing cross-owner reads',async()=>{
    const f=fixture(true,3);
    expect((await f.service.get(id,proof)).application.archivedAt).toBe(before.toISOString());
    expect((await f.service.history(id,{},proof)).items).toHaveLength(3);
    await expect(f.service.get(foreignId,proof)).rejects.toMatchObject({status:404});
    await expect(f.service.history(foreignId,{},proof)).rejects.toMatchObject({status:404});
  });
  it.each(['active','archived'] as const)('applies independent ownership and %s filters to every cursor page',async view=>{
    const f=fixture();f.change(s=>{s.apps[0]!.archivedAt=before;s.apps.push({...s.apps[0]!,id:'94974360-a70c-4a29-8b41-df95d15d7270'});});
    const expected=f.read().apps.filter(a=>a.userId===userId&&((a.archivedAt===null)===(view==='active'))).map(a=>a.id).sort().reverse();
    const first=await f.service.list({view,limit:1},proof);const ids=first.items.map(a=>a.id);
    if(first.nextCursor)ids.push(...(await f.service.list({view,limit:1,cursor:first.nextCursor},proof)).items.map(a=>a.id));
    expect(ids).toEqual(expected);expect(new Set(ids).size).toBe(ids.length);
    for(const [args]of f.list.mock.calls){expect(args.where.userId).toBe(userId);expect(args.where.archivedAt).toEqual(view==='active'?null:{not:null});expect(args.orderBy).toEqual([{createdAt:'desc'},{id:'desc'}]);}
    // A foreign cursor is only a boundary: it cannot select that owner's rows.
    const foreign=f.read().apps.find(a=>a.id===foreignId)!;
    expect((await f.service.list({view,cursor:encodeApplicationCursor(foreign)},proof)).items.every(a=>a.id!==foreignId)).toBe(true);
  });
  it('defaults to active and permits a boundary whose row has since been deleted',async()=>{
    const f=fixture();const first=await f.service.list({limit:1},proof);expect(first.items[0]!.id).toBe(id);
    await f.service.archive(id,{expectedVersion:5},proof);await f.service.delete(id,{...deletion,expectedVersion:6},proof);
    const next=await f.service.list({limit:1,cursor:first.nextCursor},proof);
    expect(next.items.map(a=>a.id)).toEqual([siblingId]);expect(next.nextCursor).toBeNull();
  });
  it.each([{view:'all'},{view:['active']},{view:null},{view:'archived',ownerId:userId},{view:'archived',cursor:'invalid'}])('rejects unsafe list query %#',async query=>{
    const f=fixture();await expect(f.service.list(query,proof)).rejects.toMatchObject({status:400});expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it.each(operations)('composes %s with the real admission, service and session-bound CSRF checks',async operation=>{
    const f=fixture(operation!=='archive'),app=http(f);
    const send=()=>operation==='delete'?request(app).delete(path):request(app).post(path+'/'+operation);
    for(const key of ['Cookie','Origin','X-ApplyFlow-Request','X-CSRF-Token']){
      await send().set(headers).unset(key).send(payload(operation)).expect(key==='Cookie'?401:403);
    }
    await send().set(headers).set('Origin','https://untrusted.invalid').send(payload(operation)).expect(403);
    await send().set(headers).set('Sec-Fetch-Site','cross-site').send(payload(operation)).expect(403);
    expect(f.update).not.toHaveBeenCalled();expect(f.removeHistory).not.toHaveBeenCalled();
    const result=await send().set(headers).send(payload(operation)).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.body).toEqual(operation==='delete'?{deletedApplicationId:id}:{application:expect.objectContaining({id,version:6})});
  });
  it('serializes safe conflict reasons only for the admitted owner',async()=>{
    const f=fixture(true),app=http(f);
    await request(app).put(path).set(headers).send(edit).expect(409,{code:'APPLICATION_CONFLICT',message:'Restore this application before editing it.',conflictReason:'APPLICATION_ARCHIVED'});
    const response=await request(app).delete(path).set(headers).send({...deletion,expectedVersion:4}).expect(409);
    expect(response.body.conflictReason).toBe('STALE_VERSION');
    await request(app).delete('/api/applications/'+foreignId).set(headers).send(deletion).expect(404,{code:'NOT_FOUND',message:'Application not found.'});
  });
  it('accepts only one substantive same-version edit/archive operation using a serialized double',async()=>{
    const f=fixture();let unlock!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(r=>{unlock=r;}),locked=new Promise<void>(r=>{ready=r;});f.hold(async()=>{ready();await gate;});
    const first=f.service.update(id,{...edit,notes:'First saved'},proof);await locked;
    const second=f.service.archive(id,{expectedVersion:5},secondProof);unlock();
    const results=await Promise.allSettled([first,second]);
    expect(results[0]!.status).toBe('fulfilled');expect(results[1]).toMatchObject({status:'rejected',reason:{status:409,conflictReason:'STALE_VERSION'}});
    expect(f.read().apps[0]).toMatchObject({version:6,archivedAt:null,notes:'First saved'});expect(f.update).toHaveBeenCalledOnce();
  });
  it('makes a restore stale after archive, but permits a restore no-op ordered before archive',async()=>{
    const archivedFirst=fixture();
    const first=await Promise.allSettled([
      archivedFirst.service.archive(id,{expectedVersion:5},proof),archivedFirst.service.restore(id,{expectedVersion:5},secondProof)
    ]);
    expect(first[0]!.status).toBe('fulfilled');expect(first[1]).toMatchObject({status:'rejected',reason:{status:409,conflictReason:'STALE_VERSION'}});
    expect(archivedFirst.update).toHaveBeenCalledOnce();
    const noopFirst=fixture();
    const second=await Promise.all([
      noopFirst.service.restore(id,{expectedVersion:5},proof),noopFirst.service.archive(id,{expectedVersion:5},secondProof)
    ]);
    expect(second.map(r=>r.application.version)).toEqual([5,6]);expect(noopFirst.update).toHaveBeenCalledOnce();
  });
});
