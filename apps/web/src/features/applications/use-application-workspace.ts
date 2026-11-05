import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { AuthStore } from '../../lib/auth/store';
import type { ApplicationsApi } from '../../lib/applications/api';
import { useApplications, type ApplicationsView, type ApplicationsController } from './use-applications';
import { useApplicationBoard } from './use-application-board';
import { useApplicationEditor, type ApplicationEditorController } from './use-application-editor';

export function useApplicationWorkspace(store: AuthStore, api: ApplicationsApi) {
  const board = useApplicationBoard(store, api);
  const applications = useApplications(store, api, board.confirmedCreated);
  const editor = useApplicationEditor(store, api, (row, lifecycle, previous) => {
    applications.replaceItem(row, lifecycle, previous);
    if (lifecycle === 'archive') board.confirmedArchived(row);
    else if (!lifecycle) board.confirmedSaved(row, previous);
  }, id => { applications.removeItem(id); board.confirmedDeleted(id); });
  const [presentation, setPresentation] = useState<'list' | 'board'>('list');
  const [entered, setEntered] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [intent, setIntent] = useState(0);
  const [account, setAccount] = useState(0);
  const lifetime = useRef({ active: false, userId: null as string | null, epoch: 0, action: false, coordination: 0, focus: '', restore: false });
  useLayoutEffect(() => {
    const owner = { active: true, userId: store.getSnapshot().user?.id ?? null, epoch: 0, action: false, coordination: 0, focus: '', restore: false };
    lifetime.current = owner;
    const unsubscribe = store.subscribe(() => {
      const auth = store.getSnapshot();
      if (auth.busy && owner.focus && document.activeElement?.id === owner.focus) owner.restore = true;
      if (auth.status === 'anonymous' || (auth.status === 'authenticated' && auth.user?.id !== owner.userId)) {
        owner.userId = auth.user?.id ?? null; owner.epoch++; owner.coordination++; owner.action = false; owner.focus = ''; owner.restore = false;
        setPresentation('list'); setEntered(false); setHandoff(false); setAccount(value => value + 1);
      }
    });
    return () => { owner.active = false; owner.epoch++; owner.coordination++; unsubscribe(); };
  }, [store]);
  const isBoard = applications.view === 'active' && presentation === 'board';
  const editorIdle = !editor.saving && !editor.loading && !editor.historyLoading && !editor.deleteConfirm;
  const q = applications.activeFilters.applied.q, status = applications.activeFilters.applied.status;
  const synchronize = useEffectEvent(async (current: () => boolean) => {
    if (handoff) { await board.pause(); return; }
    if (isBoard) {
      await applications.setCollectionEnabled(false);
      if (!current()) return;
      board.configure({ enabled: true, filters: applications.activeFilters.applied });
      if (editorIdle && !applications.saving) board.resume();
      else await board.pause();
    } else {
      await board.pause();
      if (!current()) return;
      board.configure({ enabled: false, filters: applications.activeFilters.applied });
      await applications.setCollectionEnabled(true);
      if (current()) applications.enter(editorIdle && !applications.saving);
    }
  });
  useEffect(() => {
    if (!entered) return;
    const owner = lifetime.current, epoch = owner.epoch, ticket = ++owner.coordination;
    void synchronize(() => owner.active && lifetime.current === owner && owner.epoch === epoch && owner.coordination === ticket);
    return () => { owner.coordination++; };
  }, [entered, isBoard, q, status, editorIdle, applications.saving, handoff, intent, account]);
  const enter = useCallback(() => setEntered(true), []);
  function admitted() {
    const auth = store.getSnapshot(), owner = lifetime.current;
    return owner.active && auth.status === 'authenticated' && auth.user?.id === owner.userId && !auth.busy
      && auth.verifiedReadId !== null && (auth.retryAt === null || auth.retryAt <= Date.now());
  }
  function guardMutation(action: () => void) {
    if (!admitted() || lifetime.current.action) return;
    // Synchronous admission preserves the route's current receipt. Never queue or
    // replay a mutation after a different authenticated operation changes it.
    void board.pause(); action(); setIntent(value => value + 1);
  }
  async function readAction(action: () => void) {
    const owner = lifetime.current, epoch = owner.epoch;
    const auth = store.getSnapshot();
    if (!owner.active || owner.action || editor.saving || applications.saving || auth.status !== 'authenticated' || auth.user?.id !== owner.userId) return;
    if (admitted() && !board.hasPendingRead() && !applications.hasPendingCollectionRead()) {
      void board.pause(); action(); setIntent(value => value + 1); return;
    }
    owner.action = true; owner.coordination++; setHandoff(true);
    try {
      await board.pause(); await applications.settleCollectionRead();
      if (owner.active && lifetime.current === owner && owner.epoch === epoch && admitted()) action();
    } finally {
      if (owner.active && lifetime.current === owner && owner.epoch === epoch) { owner.action = false; setHandoff(false); setIntent(value => value + 1); }
    }
  }
  const presentedEditor: ApplicationEditorController = { ...editor,
    open: id => { void readAction(() => editor.open(id)); },
    retryDetails: () => { void readAction(editor.retryDetails); },
    reload: () => { void readAction(editor.reload); },
    reviewSaved: () => { void readAction(editor.reviewSaved); },
    retryHistory: () => { void readAction(editor.retryHistory); },
    loadOlder: () => { void readAction(editor.loadOlder); },
    save: (input, canSubmit) => guardMutation(() => editor.save(input, canSubmit)),
    archive: canSubmit => guardMutation(() => editor.archive(canSubmit)),
    restore: canSubmit => guardMutation(() => editor.restore(canSubmit)),
    deletePermanently: canSubmit => guardMutation(() => editor.deletePermanently(canSubmit)),
    requestDeletion: () => guardMutation(editor.requestDeletion),
    cancelDeletion: () => guardMutation(editor.cancelDeletion),
    close: restoreFocus => { let closed = false; guardMutation(() => { closed = editor.close(restoreFocus); }); return closed; }
  };
  const presentedApplications: ApplicationsController = { ...applications,
    save: (input, canSubmit) => guardMutation(() => applications.save(input, canSubmit))
  };
  return { applications: presentedApplications, editor: presentedEditor, board, presentation, isBoard, enter, editorIdle, handoff, guardMutation,
    selectPresentation(next: 'list' | 'board') {
      if (admitted() && !lifetime.current.action && !editor.saving && !applications.saving && !editor.deleteConfirm) {
        if (next === 'list') void board.pause();
        else void applications.setCollectionEnabled(false);
        setPresentation(next); setIntent(value => value + 1);
      }
    },
    switchView(next: ApplicationsView) {
      if (next === applications.view) return;
      void readAction(() => {
        if (editor.closeForView()) {
          // Disable the old collection synchronously before switchView's legacy
          // eager read. The effect enables exactly the destination presentation.
          if (isBoard || (next === 'active' && presentation === 'board')) void applications.setCollectionEnabled(false);
          applications.switchView(next);
        }
      });
    },
    rememberFocus(id: string) { if (id) lifetime.current.focus = id; },
    restoreFocus() {
      const owner = lifetime.current;
      if (!owner.restore) return;
      owner.restore = false;
      if (document.activeElement === document.body && owner.focus) document.getElementById(owner.focus)?.focus();
    }
  };
}
export type ApplicationWorkspaceController = ReturnType<typeof useApplicationWorkspace>;
