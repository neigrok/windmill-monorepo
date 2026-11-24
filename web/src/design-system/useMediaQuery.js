import { useCallback, useSyncExternalStore } from 'react';

// Whether the page matches a media query, drawn again as it starts or stops matching. A page with no media queries to ask,
// a server render or a test without a window, answers `otherwise`.
export function useMediaQuery(query, otherwise = false) {
  const subscribe = useCallback((changed) => {
    const list = globalThis.window?.matchMedia?.(query);
    list?.addEventListener('change', changed);
    return () => list?.removeEventListener('change', changed);
  }, [query]);
  return useSyncExternalStore(subscribe, () => globalThis.window?.matchMedia?.(query).matches ?? otherwise, () => otherwise);
}
