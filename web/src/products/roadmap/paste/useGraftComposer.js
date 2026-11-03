import { useCallback, useMemo, useState } from 'react';
import { parsePlan } from './planGrammar.js';

// A plan pasted onto an open roadmap: the composer's draft, parsed as it changes. An unmatched heading mints a fresh hue
// rather than renaming an existing kind.
export function useGraftComposer() {
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  const parse = useMemo(
    () => (composerOpen ? parsePlan(draft, draftKinds, { bindOnly: true }) : null),
    [composerOpen, draft, draftKinds],
  );
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  const openComposer = useCallback((text, kinds) => {
    setDraftKinds(kinds);
    setDraft(text);
    setComposerOpen(true);
  }, []);
  return { composerOpen, draft, setDraft, draftKinds, setDraftKinds, parse, closeComposer, openComposer };
}
