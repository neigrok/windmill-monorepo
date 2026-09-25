import { useCallback, useEffect, useRef, useState } from 'react';
import { gymApi } from '../gymApi.js';
import { historyScope } from './history.js';

export function useHistory(filters, revision = 0, api = gymApi) {
  const [view, setView] = useState({ phase: 'loading', data: null, failure: false, more: 'idle', scope: null });
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0);
  const loadedScope = useRef(null);
  const pendingPage = useRef(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scope = JSON.stringify(historyScope(filters));
  useEffect(() => {
    const mine = ++epoch.current;
    pendingPage.current = null;
    setView((current) => ({ ...current, scope, more: 'idle', data: loadedScope.current === scope ? current.data : null, phase: 'loading', failure: false }));
    api.history({ ...JSON.parse(scope), timeZone, limit: 50 }).then((data) => {
      if (mine === epoch.current) { loadedScope.current = scope; setView({ phase: 'ready', data, failure: false, more: 'idle', scope }); }
    }).catch(() => {
      if (mine === epoch.current) setView((current) => ({ ...current, phase: 'failed', failure: true }));
    });
    return () => { epoch.current += 1; };
  }, [api, scope, revision, attempt, timeZone]);
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
      setView((current) => ({ ...current, data: { ...page, sessions: [...current.data.sessions, ...page.sessions] }, more: 'idle' }));
      return page;
    } catch {
      if (mine === epoch.current) setView((current) => ({ ...current, more: 'failed' }));
    } finally {
      if (pendingPage.current === token) pendingPage.current = null;
    }
  }, [api, scope, timeZone, view.data, view.phase]);
  return { ...view, ...(view.scope !== scope ? { phase: 'loading', data: null, failure: false } : {}), retry: () => setAttempt((value) => value + 1), load };
}

export function useHistoryDates(filters, revision = 0, api = gymApi) {
  const [view, setView] = useState({ months: [], failure: false });
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify(historyScope({ exercise: filters.exercise, routine: filters.routine }));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    let current = true;
    setView({ months: [], failure: false });
    api.history({ ...JSON.parse(scope), timeZone, limit: 1 }).then((data) => {
      if (current) setView({ months: data.months, failure: false });
    }).catch(() => { if (current) setView({ months: [], failure: true }); });
    return () => { current = false; };
  }, [api, scope, revision, attempt, timeZone]);
  return { ...view, retry: () => setAttempt((value) => value + 1) };
}
