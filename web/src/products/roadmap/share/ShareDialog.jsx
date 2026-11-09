import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button } from '../../../design-system';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/index.js';

// A roadmap's public address, or null for one with no id yet; a step's link adds its `?step=` to this.
export function treeShareUrl(treeId) {
  return treeId && treeId !== 'new' ? `${window.location.origin}/t/${treeId}` : null;
}

export function ShareDialog({ open, onClose, treeId, visibility, mine, onStanceChange }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  const urlRef = useRef(null);
  const shareUrl = treeShareUrl(treeId);
  const reachable = visibility === 'public' || visibility === 'unlisted';
  const publish = mine && visibility !== 'public';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setMessage('');
    setError('');
  }, [open, treeId]);

  async function handleShare() {
    if (pending.current || !shareUrl || (!mine && !reachable)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (publish) {
        await setVisibility(treeId, 'public');
        track('roadmap_verb', { verb: 'share', step: 'publish', outcome: 'ok' });
        if (!mounted.current) return;
        onStanceChange?.('public');
      }
    } catch (failure) {
      track('roadmap_verb', { verb: 'share', step: 'publish', outcome: 'failed' });
      reportUnexpectedFailure('roadmap-share', failure);
      if (!mounted.current) return;
      setError(t('roadmap.share.tryAgain', { reason: failure.message || t('roadmap.share.publishFailed') }));
      pending.current = false;
      setBusy(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (!mounted.current) return;
      track('link_copy', {});
      setMessage(t('roadmap.share.copied'));
    } catch {
      track('roadmap_verb', { verb: 'share', step: 'copy', outcome: 'failed' });
      if (!mounted.current) return;
      urlRef.current?.select();
      setError(t('roadmap.share.copyFailed'));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleMakePrivate() {
    if (pending.current || !mine || !shareUrl) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await setVisibility(treeId, 'private');
      track('roadmap_verb', { verb: 'share', step: 'private', outcome: 'ok' });
      if (!mounted.current) return;
      onStanceChange?.('private');
      setMessage(t('roadmap.share.madePrivate'));
    } catch (failure) {
      track('roadmap_verb', { verb: 'share', step: 'private', outcome: 'failed' });
      reportUnexpectedFailure('roadmap-share', failure);
      if (!mounted.current) return;
      setError(t('roadmap.share.tryAgain', { reason: failure.message || t('roadmap.share.makePrivateFailed') }));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} title={t('roadmap.share.title')} width={640} footer={null} preserveOutsideFocus>
      {!shareUrl ? <p>{t('roadmap.share.noLink')}</p> : (
        <div>
          <p>
            {publish
              ? t('roadmap.share.publishing')
              : visibility === 'public'
                ? t('roadmap.share.public')
                : reachable ? t('roadmap.share.unlisted') : t('roadmap.share.private')}
          </p>
          {reachable && (
            <input
              ref={urlRef}
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
              aria-label={t('roadmap.share.linkLabel')}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 14px', marginBottom: 12,
                borderRadius: 'var(--radius-lg)', border: '1.5px solid var(--border-default)',
                background: 'var(--surface-card)', color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)' }}
            />
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <Button variant="secondary" disabled={busy || (!mine && !reachable)} onClick={handleShare}>
              {busy ? t('roadmap.share.wait') : publish ? t('roadmap.share.publishAndCopy') : t('roadmap.share.copyLink')}
            </Button>
            {mine && reachable && <Button variant="ghost" disabled={busy} onClick={handleMakePrivate}>{t('roadmap.share.makePrivate')}</Button>}
          </div>
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
