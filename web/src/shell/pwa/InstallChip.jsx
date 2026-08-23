// The PWA install offer. iOS Safari never fires the event, so this renders nothing there.

import React, { useState, useSyncExternalStore } from 'react';
import { Button, Icon, IconButton } from '../../design-system';
import { forgetInstallPrompt, installPrompt, watchInstallPrompt } from './installPrompt.js';

const DISMISSED_KEY = 'windmill:install-dismissed';

function readDismissed() {
  try { return Boolean(localStorage.getItem(DISMISSED_KEY)); } catch { return false; }
}

function rememberDismissed() {
  try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* storage unavailable */ }
}

const CSS = `
.wm-install-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 24px;
  padding: 10px 10px 10px 16px;
  max-width: 520px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
}
.wm-install-chip-copy {
  flex: 1;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-secondary);
}
`;

export function InstallChip() {
  const captured = useSyncExternalStore(watchInstallPrompt, installPrompt, () => null);
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!captured || dismissed) return null;

  // Drop the stash before prompt() so a double-tap finds nothing; a replayed prompt() rejects.
  const accept = async () => {
    forgetInstallPrompt();
    try {
      await captured.prompt();
      const { outcome } = await captured.userChoice;
      if (outcome !== 'dismissed') return;
      rememberDismissed();
      setDismissed(true);
    } catch { /* the browser refused the prompt */ }
  };
  const dismiss = () => {
    rememberDismissed();
    setDismissed(true);
    forgetInstallPrompt();
  };

  return (
    <div className="wm-install-chip">
      <style>{CSS}</style>
      <span className="wm-install-chip-copy">Windmill can live on your home screen — it opens even offline.</span>
      <Button variant="secondary" size="sm" onClick={accept}>Install</Button>
      <IconButton icon={<Icon name="x" size={16} />} label="Not now" size="sm" onClick={dismiss} />
    </div>
  );
}

export default InstallChip;
