import { useMemo, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';
import { useGymApi } from './gymSync.js';

export function useDomainRead(read) {
  const api = useGymApi();
  const records = useSyncRecords('self/gym');
  const [attempt, retry] = useState(0);
  const view = useMemo(() => {
    if (!api) return { phase: 'loading', data: null };
    try { return { phase: 'ready', data: api.read(read) }; }
    catch { return { phase: 'failed', data: null }; }
  }, [api, records, attempt]);
  return { ...view, retry: () => retry((value) => value + 1) };
}
