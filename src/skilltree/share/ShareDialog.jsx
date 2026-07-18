// The Share surface (X2 identity), link-only: a copyable share URL and the tree's
// sharing stance. Copying a private tree's link flips it to unlisted so the recipient
// can view; the owner can lock it back to private. No image export — the link is the
// whole surface.

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button } from '../../components';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { track } from '../../telemetry/beacon.js';

export function ShareDialog({ open, onClose, visibility, mine }) {
  const [linkCopied, setLinkCopied] = useState(false);
  // The tree's live sharing stance. Seeded from the server's answer, but the owner's copy-link
  // flip and the Make-private toggle move it here without a reload — so the dialog's stance line
  // always states the reach the server actually holds, never a stale prop.
  const [stance, setStance] = useState(visibility ?? null);
  const copiedTimer = useRef(null);

  const treeId = treeIdFromHash(window.location.hash);
  const shareUrl = treeId ? `${window.location.origin}/#/t/${treeId}?ref=share` : null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Re-seed the stance whenever the server's answer changes or the dialog reopens, so a
  // reload's fresh visibility replaces any flip we made in a prior opening.
  useEffect(() => { setStance(visibility ?? null); }, [visibility, open]);

  async function handleCopyLink() {
    if (!(await copyText(shareUrl))) return;
    track('link_copy', {});
    setLinkCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setLinkCopied(false), 1500);
    // A private tree is owner-only on the server, so its copied link would 404 for the
    // recipient. When the owner shares, flip it to unlisted — anyone with the link can then
    // view. Guarded on mine + private so a non-owner's call never fires (it would 403) and a
    // public tree is never lowered. If the flip fails the link still copied; the stance stays
    // private, so the dialog never claims a reach the server won't honor.
    if (mine && stance === 'private') {
      try {
        await setVisibility(treeId, 'unlisted');
        setStance('unlisted');
      } catch { /* keep the private stance — no false promise of reach */ }
    }
  }

  // The owner's deliberate reverse: lock the tree back to owner-only. Its link goes dark, and
  // the stance line retreats with it.
  async function handleMakePrivate() {
    try {
      await setVisibility(treeId, 'private');
      setStance('private');
    } catch { /* leave the stance as it stands */ }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Share roadmap" width={640} footer={null}>
      {shareUrl ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.target.select()}
              aria-label="Shareable link"
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                padding: '10px 14px',
                borderRadius: 'var(--radius-lg)',
                border: '1.5px solid var(--border-default)',
                background: 'var(--surface-card)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                outline: 'none',
                textOverflow: 'ellipsis',
              }}
            />
            <Button variant="secondary" onClick={handleCopyLink}>{linkCopied ? 'Copied' : 'Copy link'}</Button>
          </div>

          {(stance === 'unlisted' || stance === 'public') && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              <span>Anyone with this link can view.</span>
              {mine && (
                <button
                  type="button"
                  onClick={handleMakePrivate}
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--text-secondary)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px' }}
                >
                  Make private
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>This roadmap has no shareable link yet.</div>
      )}
    </Dialog>
  );
}

function treeIdFromHash(hash) {
  const path = hash.split('?')[0];
  for (const prefix of ['#/t/', '#/app/']) {
    if (!path.startsWith(prefix)) continue;
    const id = path.slice(prefix.length);
    if (id && id !== 'new') return id;
  }
  return null;
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
