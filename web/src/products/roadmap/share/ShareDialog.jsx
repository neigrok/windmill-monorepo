import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button } from '../../../design-system';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { track } from '../../../telemetry/beacon.js';

export function ShareDialog({ open, onClose, treeId, visibility, mine, onStanceChange }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  const urlRef = useRef(null);
  const shareUrl = treeId && treeId !== 'new' ? `${window.location.origin}/t/${treeId}` : null;
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
        if (!mounted.current) return;
        onStanceChange?.('public');
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(`${failure.message || 'Could not publish the roadmap'}. Try again.`);
      pending.current = false;
      setBusy(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (!mounted.current) return;
      track('link_copy', {});
      setMessage('Link copied.');
    } catch {
      if (!mounted.current) return;
      urlRef.current?.select();
      setError('Could not copy the link. Select the link to copy it manually, or try again.');
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
      if (!mounted.current) return;
      onStanceChange?.('private');
      setMessage('Roadmap is private. Only you can view it.');
    } catch (failure) {
      if (!mounted.current) return;
      setError(`${failure.message || 'Could not make the roadmap private'}. Try again.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} title="Share roadmap" width={640} footer={null}>
      {!shareUrl ? <p>This roadmap has no shareable link yet.</p> : (
        <div>
          <p>
            {publish
              ? 'Publishing makes this roadmap public. Anyone can view and fork it, and it can appear in the public gallery.'
              : visibility === 'public'
                ? 'This roadmap is public. Anyone can view and fork it, and it can appear in the public gallery.'
                : reachable ? 'Anyone with this link can view and fork this roadmap.' : 'This roadmap is private. Only its owner can publish it.'}
          </p>
          {reachable && (
            <input
              ref={urlRef}
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
              aria-label="Shareable link"
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 14px', marginBottom: 12,
                borderRadius: 'var(--radius-lg)', border: '1.5px solid var(--border-default)',
                background: 'var(--surface-card)', color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)' }}
            />
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <Button variant="secondary" disabled={busy || (!mine && !reachable)} onClick={handleShare}>
              {busy ? 'Please wait…' : publish ? 'Publish and copy link' : 'Copy link'}
            </Button>
            {mine && reachable && <Button variant="ghost" disabled={busy} onClick={handleMakePrivate}>Make private</Button>}
          </div>
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
