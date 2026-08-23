import { useCallback, useEffect, useState } from 'react';
import { readAppearance, resolveAppearance, systemAppearance, watchSystemAppearance, writeAppearance } from './appearance.js';

export function useAppearance() {
  const [choice, setChoice] = useState(readAppearance);
  const [system, setSystem] = useState(systemAppearance);

  // Only listen while the choice is 'system'.
  useEffect(() => {
    if (choice !== 'system') return undefined;
    return watchSystemAppearance(setSystem);
  }, [choice]);

  const set = useCallback((next) => {
    writeAppearance(next);
    setChoice(next);
  }, []);

  return { choice, resolved: resolveAppearance(choice, system), set };
}
