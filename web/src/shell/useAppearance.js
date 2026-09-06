import { useSyncExternalStore } from 'react';
import { getAppearance, setAppearance, subscribeAppearance } from './appearance.js';

export function useAppearance() {
  const { choice, resolved } = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  return { choice, resolved, set: setAppearance };
}
