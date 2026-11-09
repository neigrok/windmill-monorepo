import React, { useState } from 'react';
import { failureReason } from '../errors.js';
import { gymApi } from '../gymApi.js';
import { t } from '../i18n/index.js';
import { expiryLine, SHARE_OFFER, SHARE_OFFER_LINE, SHARE_TERMS, shareLink } from './share.js';

export function ShareWorkout({ sessionId }) {
  const [share, setShare] = useState(null);        // { token, expiresAt } once one is live
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      setShare(await gymApi.shareSession(sessionId));
    } catch (error) {
      setNote(t('gym.share.notMade', { reason: failureReason(error) }));
    }
    setBusy(false);
  };

  // A revoke that finds nothing (404) answers null, not an error.
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      await gymApi.revokeShare(sessionId);
      setShare(null);
      setCopied(false);
      setNote(t('gym.share.revoked'));
    } catch (error) {
      setNote(t('gym.share.notRevoked', { reason: failureReason(error) }));
    }
    setBusy(false);
  };

  if (!share) {
    return (
      <section className="gym-share">
        <h2 className="gym-share-title">{SHARE_OFFER}</h2>
        <p className="gym-share-line">{SHARE_OFFER_LINE}</p>
        <button type="button" className="gym-share-make" onClick={mint} aria-busy={busy}>
          {busy ? t('gym.share.making') : t('gym.share.make')}
        </button>
        {note && <p className="gym-share-note">{note}</p>}
      </section>
    );
  }

  const link = shareLink(share.token, typeof window === 'undefined' ? '' : window.location.origin);
  return (
    <section className="gym-share">
      <h2 className="gym-share-title">{SHARE_OFFER}</h2>
      <input
        className="gym-share-link"
        value={link}
        readOnly
        aria-label={t('gym.share.linkLabel')}
        onFocus={(event) => event.target.select()}
      />
      <div className="gym-share-actions">
        <button
          type="button"
          className="gym-share-copy"
          onClick={async () => setCopied(await copyText(link))}
        >
          {copied ? t('gym.share.copied') : t('gym.share.copy')}
        </button>
        <button type="button" className="gym-share-revoke" onClick={revoke} aria-busy={busy}>
          {busy ? t('gym.share.revoking') : t('gym.share.revoke')}
        </button>
      </div>
      <ul className="gym-share-terms">
        {SHARE_TERMS.map((term) => <li key={term}>{term}</li>)}
        <li>{expiryLine(share.expiresAt)}</li>
      </ul>
      {note && <p className="gym-share-note">{note}</p>}
    </section>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }
}
