import { useCallback, useEffect, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { useGymApi } from './gymSync.js';

export function useDomainRead(read) {
  const api = useGymApi();
  useSyncRecords('self/gym');
  const [, redraw] = useState(0);
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
  // A read's Moment and its display inputs belong to this render, even without a sync update.
  if (!api) return { phase: 'loading', data: null, retry };
  try { return { phase: 'ready', data: api.read(read), retry }; }
  catch { return { phase: 'failed', data: null, retry }; }
}
