// Unattributable unsent pages, waiting in quarantine (pageCache.js) and offered once to a signed-in
// person. This surface may say the day and the length, never the words.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { styles } from '../../../shell/settings/Section.jsx';
import { dropUnclaimedPages, unclaimedPages } from '../pageCache.js';
import { restoreUnclaimedPages } from '../pageStore.js';

function words(body) {
  const count = body.trim() ? body.trim().split(/\s+/).length : 0;
  return `${count} word${count === 1 ? '' : 's'}`;
}

export function UnclaimedPagesRow({ account }) {
  const [waiting, setWaiting] = useState(() => unclaimedPages());
  const [phase, setPhase] = useState('idle'); // idle | working | done | error
  const [note, setNote] = useState('');

  if (!waiting.length) return null;

  const restore = async () => {
    setPhase('working');
    try {
      const taken = await restoreUnclaimedPages(account);
      if (!taken) {
        setPhase('error');
        setNote('This browser would not give them up just now — they are still here, try again.');
        return;
      }
      setWaiting([]);
      setPhase('done');
      setNote(`Restored ${taken} page${taken === 1 ? '' : 's'} into your journal.`);
    } catch {
      setPhase('error');
      setNote('Something went wrong — they are still here, nothing was lost.');
    }
  };

  const discard = () => {
    dropUnclaimedPages();
    setWaiting([]);
    setPhase('done');
    setNote('Deleted from this browser.');
  };

  return (
    <div style={{ marginTop: 14 }}>
      <p style={{ ...styles.fieldLabel, margin: '0 0 5px' }}>Unsent pages from before this update</p>
      <p style={styles.calmLine}>
        {waiting.length === 1 ? 'One page was' : `${waiting.length} pages were`} written on this browser
        before Windmill kept pages per account, and never reached a journal. We cannot tell whose they
        are, so nothing has been added to yours. Restore them only if they are your writing — they will
        be joined onto your own pages for those days, never written over them.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
        {waiting.map((page) => (
          <li key={page.day} style={{ ...styles.metaText, marginTop: 2 }}>{page.day} · {words(page.body)}</li>
        ))}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <Button variant="secondary" size="sm" disabled={!account || phase === 'working'} onClick={restore}>
          {phase === 'working' ? 'Restoring…' : 'These are mine — restore them'}
        </Button>
        <Button variant="ghost" size="sm" disabled={phase === 'working'} onClick={discard}>Discard them</Button>
      </div>
      {!account && <p style={{ ...styles.metaText, marginTop: 6 }}>Sign in to restore them.</p>}
      {note && (
        <p style={{ ...styles.metaText, color: phase === 'error' ? 'var(--color-danger)' : 'var(--accent-olive-600)', marginTop: 6 }}>
          {note}
        </p>
      )}
    </div>
  );
}

export default UnclaimedPagesRow;
