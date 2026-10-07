import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { useGymApi } from './gymSync.js';

export function useDomainRead(read, inputs = []) {
  const api = useGymApi();
  const records = useSyncRecords('self/gym');
  const [refresh, redraw] = useState(0);
  const today = new Date().toDateString();
  const retry = useCallback(() => redraw((value) => value + 1), []);
  useEffect(() => {
    let timer;
    const schedule = () => {
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, midnight.getTime() - now);
    };
    const refresh = () => {
      clearTimeout(timer);
      retry();
      schedule();
    };
    const resume = () => { if (document.visibilityState === 'visible') refresh(); };
    schedule();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [retry]);
  // Inline selectors name their changing inputs; observations also include device-only metadata.
  return useMemo(() => {
    if (!api) return { phase: 'loading', data: null, retry };
    try { return { phase: 'ready', data: api.read(read), retry }; }
    catch { return { phase: 'failed', data: null, retry }; }
  }, [api, records, refresh, today, ...inputs]);
}
