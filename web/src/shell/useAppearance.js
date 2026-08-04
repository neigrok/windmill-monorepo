import { useCallback, useEffect, useState } from 'react';
import { readAppearance, resolveAppearance, systemAppearance, watchSystemAppearance, writeAppearance } from './appearance.js';

// The one hook every surface that cares about light-or-dark uses — the shell to dress itself, the
// settings section to offer the choice, journal to pick which of its two skins it is wearing.
// Kept beside the pure module rather than inside it so the rules stay testable without React.
export function useAppearance() {
  const [choice, setChoice] = useState(readAppearance);
  const [system, setSystem] = useState(systemAppearance);

  // Only listen while the choice is 'system': an explicit light or dark must not move when the
  // machine flips at sunset.
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
