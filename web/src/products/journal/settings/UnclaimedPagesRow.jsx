// Unattributable unsent pages, waiting in quarantine (pages.js) and offered once to a signed-in
// person. This surface may say the day and the length, never the words.

import React, { useState } from 'react';
import { captureError } from '../../../telemetry/sentry.js';
import { Button } from '../../../design-system';
import { styles } from '../../../shell/settings/Section.jsx';
import { dropUnclaimedPages, restoreUnclaimedPages, unclaimedPages } from '../pages.js';
import { t } from '../i18n/index.js';

function wordCount(body) {
  return body.trim() ? body.trim().split(/\s+/).length : 0;
}

export function UnclaimedPagesRow({ account }) {
  const [waiting, setWaiting] = useState(() => unclaimedPages());
  const [phase, setPhase] = useState('idle'); // idle | working | done | error
  const [note, setNote] = useState('');

  if (!waiting.length && !note) return null;

  const restore = async () => {
    setPhase('working');
    try {
      const taken = await restoreUnclaimedPages(account);
      setWaiting([]);
      setPhase('done');
      setNote(taken ? t('journal.settings.restored', { count: taken }) : t('journal.settings.noLongerWaiting'));
    } catch {
      captureError('journal', 'journal-restore', '', '/journal');
      setPhase('error');
      setNote(t('journal.settings.restoreFailed'));
    }
  };

  const discard = async () => {
    setPhase('working');
    try {
      await dropUnclaimedPages();
      setWaiting([]);
      setPhase('done');
      setNote(t('journal.settings.discarded'));
    } catch {
      captureError('journal', 'journal-discard', '', '/journal');
      setPhase('error');
      setNote(t('journal.settings.discardFailed'));
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      {waiting.length > 0 && <>
        <p style={{ ...styles.fieldLabel, margin: '0 0 5px' }}>{t('journal.settings.unsentTitle')}</p>
        <p style={styles.calmLine}>{t('journal.settings.unsentBody', { count: waiting.length })}</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {waiting.map((page) => (
            <li key={page.day} style={{ ...styles.metaText, marginTop: 2 }}>
              {t('journal.settings.unsentPage', { day: page.day, count: wordCount(page.body) })}
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <Button variant="secondary" size="sm" disabled={!account || phase === 'working'} onClick={restore}>
            {phase === 'working' ? t('journal.settings.restoring') : t('journal.settings.restore')}
          </Button>
          <Button variant="ghost" size="sm" disabled={phase === 'working'} onClick={discard}>{t('journal.settings.discard')}</Button>
        </div>
        {!account && <p style={{ ...styles.metaText, marginTop: 6 }}>{t('journal.settings.signInToRestore')}</p>}
      </>}
      {note && (
        <p style={{ ...styles.metaText, color: phase === 'error' ? 'var(--color-danger)' : 'var(--accent-olive-600)', marginTop: 6 }}>
          {note}
        </p>
      )}
    </div>
  );
}

export default UnclaimedPagesRow;
