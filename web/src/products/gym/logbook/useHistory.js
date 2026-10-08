import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { useGymApi } from '../gymRuntime.js';
import { historyScope } from './history.js';

// `reader` answers `history(query)`: the log's own over the replica unless a caller hands another, such
// as a shared log's door. A live reader reads again whenever the replica changes; the log's own is live.
export function useHistory(filters, reader = null) {
  const log = useGymApi();
  const api = reader ?? log;
  const live = reader ? reader.live : true;
  const records = useSyncRecords('self/gym');
  const [view, setView] = useState({ phase: 'loading', data: null, failure: false, more: 'idle', scope: null });
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0);
  const loadedScope = useRef(null);
  const loadedCount = useRef(50);
  const pendingPage = useRef(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scope = JSON.stringify(historyScope(filters));
  useEffect(() => {
    const mine = ++epoch.current;
    pendingPage.current = null;
    if (!api?.ready) return;
    const limit = loadedScope.current === scope ? loadedCount.current : 50;
    setView((current) => ({ ...current, scope, more: 'idle', data: loadedScope.current === scope ? current.data : null,
      phase: loadedScope.current === scope && current.data ? 'ready' : 'loading', failure: false }));
    (async () => {
      let data = await api.history({ ...JSON.parse(scope), timeZone, limit: Math.min(200, limit) });
      while (limit > 200 && live && data.sessions.length < limit && data.next) {
        if (mine !== epoch.current) return;
        const page = await api.history({ ...JSON.parse(scope), ...data.next, timeZone, limit: Math.min(200, limit - data.sessions.length) });
        if (!page.sessions.length || (page.next?.before === data.next.before && page.next?.beforeId === data.next.beforeId)) throw new Error('History page did not advance.');
        data = { ...page, sessions: [...data.sessions, ...page.sessions] };
      }
      if (mine !== epoch.current) return;
      loadedCount.current = Math.max(50, data.sessions.length);
      loadedScope.current = scope;
      setView({ phase: 'ready', data, failure: false, more: 'idle', scope });
    })().catch(() => {
      if (mine === epoch.current) setView((current) => ({ ...current, phase: 'failed', failure: true }));
    });
    return () => { epoch.current += 1; };
  }, [api, scope, attempt, timeZone, live ? records : null]);
  const load = useCallback(async () => {
    if (!view.data?.next || pendingPage.current !== null || view.phase !== 'ready') return;
    const token = {};
    pendingPage.current = token;
    const mine = epoch.current;
    setView((current) => ({ ...current, more: 'loading' }));
    try {
      const page = await api.history({ ...JSON.parse(scope), ...view.data.next, timeZone, limit: 50 });
      if (mine !== epoch.current) return null;
      pendingPage.current = null;
      setView((current) => {
        const sessions = [...current.data.sessions, ...page.sessions];
        loadedCount.current = Math.max(50, sessions.length);
        return { ...current, data: { ...page, sessions }, more: 'idle' };
      });
      return page;
    } catch {
      if (mine === epoch.current) setView((current) => ({ ...current, more: 'failed' }));
    } finally {
      if (pendingPage.current === token) pendingPage.current = null;
    }
  }, [api, scope, timeZone, view.data, view.phase]);
  return { ...view, ...(view.scope !== scope ? { phase: 'loading', data: null, failure: false } : {}), retry: () => setAttempt((value) => value + 1), load };
}

export function useHistoryDates(filters, reader = null) {
  const log = useGymApi();
  const api = reader ?? log;
  const live = reader ? reader.live : true;
  const records = useSyncRecords('self/gym');
  const [view, setView] = useState({ months: [], failure: false });
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify(historyScope({ exercise: filters.exercise, routine: filters.routine }));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    let current = true;
    if (!api?.ready) return;
    setView({ months: [], failure: false });
    api.history({ ...JSON.parse(scope), timeZone, limit: 1 }).then((data) => {
      if (current) setView({ months: data.months, failure: false });
    }).catch(() => { if (current) setView({ months: [], failure: true }); });
    return () => { current = false; };
  }, [api, scope, attempt, timeZone, live ? records : null]);
  return { ...view, retry: () => setAttempt((value) => value + 1) };
}
