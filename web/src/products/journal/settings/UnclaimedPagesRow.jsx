// The pages nobody can attribute — and the one door they may leave by.
//
// Every browser that ran journal before 2026-08-22 kept its pages under a single key with no
// account in it. What was already SENT is safe to drop (the account it belongs to still has it),
// but what was never sent exists nowhere else, and there is no honest way to tell whether it was a
// signed-out visitor's draft or a signed-in person's page written on a plane. Handing it to whoever
// signs in next is the leak this whole wave closed, so it waits in quarantine instead
// (pageCache.js) and is offered here, to a signed-in person, once.
//
// WHAT THIS SURFACE MAY SAY IS THE DAY AND THE LENGTH, NEVER THE WORDS. Whoever is reading this
// page may not be who wrote them; a date and a count is enough to recognise your own writing and is
// not the private prose the quarantine exists to protect.

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
