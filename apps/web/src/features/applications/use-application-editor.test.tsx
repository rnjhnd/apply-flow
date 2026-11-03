import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application, UpdateApplicationRequest } from '@applyflow/contracts';
import { authFixture, deferred, user } from '../../test/auth-fixtures';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';
import { useApplicationEditor } from './use-application-editor';

const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, archivedAt: null, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
  applicationDate: null, location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const input: UpdateApplicationRequest = { company: 'Acme', jobTitle: 'Engineer', status: 'SAVED', applicationDate: null, location: null, jobUrl: null, notes: null, expectedVersion: 1 };
const event = { id: user.id, fromStatus: 'SAVED' as const, toStatus: 'APPLIED' as const, applicationVersion: 2, changedAt: row.createdAt };
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.store.dispose()); });
async function fixture() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
  const api = { create: vi.fn<ApplicationsApi['create']>(), list: vi.fn<ApplicationsApi['list']>(),
    get: vi.fn<ApplicationsApi['get']>().mockResolvedValue({ application: row }),
    update: vi.fn<ApplicationsApi['update']>().mockResolvedValue({ application: { ...row, version: 2 } }),
    history: vi.fn<ApplicationsApi['history']>().mockResolvedValue({ items: [], nextCursor: null }) };
  const saved = vi.fn();
  const hook = renderHook(() => useApplicationEditor(auth.store, api, saved), { wrapper: StrictMode });
  return { ...hook, auth, api, saved, open: async () => { await act(async () => { hook.result.current.open(row.id); }); } };
}
describe('account-owned editor lifecycle', () => {
  it('waits for fresh details before prefilling and then reads history', async () => {
    const f = await fixture(), gate = deferred<{ application: Application }>(); f.api.get.mockReturnValue(gate.promise);
    act(() => f.result.current.open(row.id));
    expect(f.result.current.draft).toBeNull(); expect(f.api.history).not.toHaveBeenCalled();
    await act(async () => { gate.resolve({ application: { ...row, version: 3, company: 'Fresh company', notes: 'Kept\n  spaces' } }); });
    expect(f.result.current.draft).toMatchObject({ company: 'Fresh company', notes: 'Kept\n  spaces', applicationDate: '' });
    expect(f.result.current.application?.version).toBe(3); expect(f.api.history).toHaveBeenCalledOnce(); expect(f.result.current.dirty).toBe(false);
  });
  it('saves a non-status edit once, updates the loaded item and leaves history alone', async () => {
    const f = await fixture(); await f.open(); const gate = deferred<{ application: Application }>(); f.api.update.mockReturnValue(gate.promise);
    act(() => { f.result.current.setDraft({ ...f.result.current.draft!, notes: 'Edited' }); });
    act(() => { f.result.current.save({ ...input, notes: 'Edited' }, () => true); f.result.current.save(input, () => true); f.result.current.close(); f.result.current.open(user.id); });
    expect(f.api.update).toHaveBeenCalledOnce(); expect(f.result.current.selectedId).toBe(row.id);
    await act(async () => { gate.resolve({ application: { ...row, notes: 'Edited', version: 2 } }); });
    expect(f.saved).toHaveBeenCalledWith(expect.objectContaining({ version: 2 })); expect(f.result.current.notice).toBe('Changes saved.');
    expect(f.result.current.dirty).toBe(false); expect(f.api.history).toHaveBeenCalledOnce();
  });
  it('accepts a server-confirmed no-op without manufacturing a revision or history refresh', async () => {
    const f = await fixture(); await f.open(); f.api.update.mockResolvedValue({ application: row });
    await act(async () => { f.result.current.save(input, () => true); });
    expect(f.result.current.application).toEqual(row); expect(f.result.current.notice).toMatch(/No changes needed/); expect(f.api.history).toHaveBeenCalledOnce();
  });
  it('keeps a confirmed status save successful when follow-up history fails and retries only the read', async () => {
    const f = await fixture(); await f.open(); f.api.history.mockRejectedValueOnce(new ApplicationFailure('unknown'));
    f.api.update.mockResolvedValue({ application: { ...row, status: 'APPLIED', applicationDate: '2024-02-29', version: 2 } });
    await act(async () => { f.result.current.save({ ...input, status: 'APPLIED', applicationDate: '2024-02-29' }, () => true); });
    expect(f.result.current.notice).toBe('Changes saved.'); expect(f.result.current.failure).toBeNull(); expect(f.result.current.historyError).toBe(true);
    f.api.history.mockResolvedValue({ items: [event], nextCursor: null });
    await act(async () => { f.result.current.retryHistory(); });
    expect(f.result.current.history).toEqual([event]); expect(f.api.update).toHaveBeenCalledOnce();
  });
  it.each(['conflict','unknown'] as const)('retains a %s draft for read-only review and explicit confirmed reload', async kind => {
    const f = await fixture(); await f.open();
    act(() => f.result.current.setDraft({ ...f.result.current.draft!, company: 'Private draft' }));
    f.api.update.mockRejectedValue(kind === 'conflict' ? new ApplicationFailure('http', 409, undefined, null, 'APPLICATION_CONFLICT') : new ApplicationFailure('unknown'));
    await act(async () => { f.result.current.save({ ...input, company: 'Private draft' }, () => true); });
    await act(async () => { await f.auth.store.revalidate(); f.result.current.save(input, () => true); });
    expect(f.result.current.recovery).toBe(kind); expect(f.result.current.draft?.company).toBe('Private draft'); expect(f.api.update).toHaveBeenCalledOnce();
    f.api.get.mockResolvedValue({ application: { ...row, company: 'Saved elsewhere', version: 3 } });
    await act(async () => { f.result.current.reviewSaved(); });
    expect(f.result.current.review?.version).toBe(3); expect(f.result.current.draft?.company).toBe('Private draft'); expect(f.result.current.application?.version).toBe(1);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => f.result.current.reload()); expect(f.api.get).toHaveBeenCalledTimes(2);
    confirm.mockReturnValue(true); await act(async () => { f.result.current.reload(); });
    expect(f.result.current.draft?.company).toBe('Saved elsewhere'); expect(f.result.current.recovery).toBeNull(); expect(f.api.update).toHaveBeenCalledOnce();
  });
  it('requires confirmation to close or switch a dirty draft and preserves it when declined', async () => {
    const f = await fixture(); await f.open(); act(() => f.result.current.setDraft({ ...f.result.current.draft!, notes: 'Draft' }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => { f.result.current.close(); f.result.current.open(user.id); });
    expect(confirm).toHaveBeenCalledTimes(2); expect(f.result.current.draft?.notes).toBe('Draft'); expect(f.api.get).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true); act(() => f.result.current.close()); expect(f.result.current.selectedId).toBeNull();
  });
  it('aborts and rejects a late detail response after selecting another application', async () => {
    const f = await fixture(), gate = deferred<{ application: Application }>(); f.api.get.mockReturnValueOnce(gate.promise);
    act(() => f.result.current.open(row.id)); const signal = f.api.get.mock.calls[0]![1];
    f.api.get.mockResolvedValue({ application: { ...row, id: user.id, company: 'Second role' } });
    await act(async () => { f.result.current.open(user.id); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { gate.resolve({ application: row }); });
    expect(f.result.current.selectedId).toBe(user.id); expect(f.result.current.draft?.company).toBe('Second role');
  });
  it('rejects late history after selection changes and prevents duplicate cursor reads', async () => {
    const f = await fixture(); f.api.history.mockResolvedValueOnce({ items: [{ ...event, applicationVersion: 4 }], nextCursor: '4' }); await f.open();
    const gate = deferred<{ items: typeof event[]; nextCursor: string | null }>(); f.api.history.mockReturnValueOnce(gate.promise);
    act(() => { f.result.current.loadOlder(); f.result.current.loadOlder(); }); expect(f.api.history).toHaveBeenCalledTimes(2);
    f.api.get.mockResolvedValue({ application: { ...row, id: user.id } });
    await act(async () => { f.result.current.open(user.id); });
    await act(async () => { gate.resolve({ items: [event], nextCursor: null }); });
    expect(f.result.current.history).toEqual([]); expect(f.result.current.selectedId).toBe(user.id);
  });
  it('appends older history in revision order while preserving the draft', async () => {
    const f = await fixture(); f.api.history.mockResolvedValueOnce({ items: [{ ...event, applicationVersion: 4 }], nextCursor: '4' }); await f.open();
    act(() => f.result.current.setDraft({ ...f.result.current.draft!, notes: 'Still editing' }));
    f.api.history.mockResolvedValue({ items: [{ ...event, id: row.id }], nextCursor: null });
    await act(async () => { f.result.current.loadOlder(); });
    expect(f.api.history.mock.calls[1]![1]).toEqual({ cursor: '4' }); expect(f.result.current.history.map(item => item.applicationVersion)).toEqual([4,2]);
    expect(f.result.current.draft?.notes).toBe('Still editing'); expect(f.result.current.historyCursor).toBeNull();
  });
  it('retries a failed older-page cursor without discarding already loaded history', async () => {
    const f = await fixture(); f.api.history.mockResolvedValueOnce({ items: [{ ...event, applicationVersion: 4 }], nextCursor: '4' }); await f.open();
    f.api.history.mockRejectedValueOnce(new ApplicationFailure('unknown'));
    await act(async () => { f.result.current.loadOlder(); });
    expect(f.result.current.history.map(item => item.applicationVersion)).toEqual([4]); expect(f.result.current.historyError).toBe(true);
    f.api.history.mockResolvedValue({ items: [{ ...event, id: row.id }], nextCursor: null });
    await act(async () => { f.result.current.retryHistory(); });
    expect(f.api.history.mock.calls[2]![1]).toEqual({ cursor: '4' }); expect(f.result.current.history.map(item => item.applicationVersion)).toEqual([4,2]);
  });
  it('preserves the same-account draft across proof loss and rejects the interrupted history result', async () => {
    const f = await fixture(); await f.open(); act(() => f.result.current.setDraft({ ...f.result.current.draft!, notes: 'Keep me' }));
    const gate = deferred<{ items: typeof event[]; nextCursor: string | null }>(); f.api.history.mockReturnValueOnce(gate.promise);
    act(() => f.result.current.retryHistory()); act(() => f.auth.notify('suspend'));
    await act(async () => { gate.resolve({ items: [event], nextCursor: null }); });
    expect(f.result.current.draft?.notes).toBe('Keep me'); expect(f.result.current.history).toEqual([]);
    await act(async () => { f.auth.notify('resume'); }); expect(f.result.current.draft?.notes).toBe('Keep me');
  });
  it.each(['logout','replacement'] as const)('clears all private state on confirmed %s and ignores a late PUT', async outcome => {
    const f = await fixture(); await f.open(); const gate = deferred<{ application: Application }>(); f.api.update.mockReturnValue(gate.promise);
    act(() => { f.result.current.setDraft({ ...f.result.current.draft!, notes: 'Private' }); f.result.current.save(input, () => true); });
    await act(async () => {
      if (outcome === 'logout') await f.auth.store.logout();
      else { f.auth.api.me.mockResolvedValue({ user: { ...user, id: row.id } }); await f.auth.store.revalidate(); }
    });
    await act(async () => { gate.resolve({ application: { ...row, version: 2 } }); });
    expect(f.result.current).toMatchObject({ selectedId: null, draft: null, application: null, history: [], review: null, failure: null });
    expect(f.saved).not.toHaveBeenCalled(); expect(f.api.history).toHaveBeenCalledOnce();
  });
  it('does not abort or replay a PUT on unmount, or accept its late result', async () => {
    const f = await fixture(); await f.open(); const gate = deferred<{ application: Application }>(); f.api.update.mockReturnValue(gate.promise);
    act(() => f.result.current.save(input, () => true)); f.unmount();
    await act(async () => { gate.resolve({ application: { ...row, version: 2 } }); });
    expect(f.api.update).toHaveBeenCalledOnce(); expect(f.saved).not.toHaveBeenCalled(); expect(f.api.history).toHaveBeenCalledOnce(); expect(f.auth.subscriptions()).toBe(0);
  });
  it('blocks programmatic saves without route admission', async () => {
    const f = await fixture(); await f.open(); act(() => f.result.current.save(input, () => false)); expect(f.api.update).not.toHaveBeenCalled();
  });
});
