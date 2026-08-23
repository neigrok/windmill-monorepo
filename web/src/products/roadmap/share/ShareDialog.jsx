// The Share surface, in two segments: the first shares the tree — a copyable URL and its sharing
// stance, with the unfurl card published in the background via onShareLink — and the second shares
// this week of the tree as a picture. The three stances are two decisions: private→unlisted is
// reach, and copying the link makes it; unlisted→public is listing, a separate consent, and only it
// puts a tree in /gallery.

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button, Switch } from '../../../design-system';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { track } from '../../../telemetry/beacon.js';
import { ProgressCardSegment } from './ProgressCardSegment.jsx';

// `stance` is the caller's; every flip made here is reported back through onStanceChange rather
// than mirrored in local state.
export function ShareDialog({ open, onClose, visibility, mine, onShareLink, onStanceChange, weekSegment = null }) {
  const [linkCopied, setLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false); // clipboard denied — the link is still selectable
  const copiedTimer = useRef(null);
  const urlRef = useRef(null);

  const stance = visibility ?? null;
  const treeId = treeIdFromHash(window.location.hash);
  // The indexable share URL: a shared tree lives at /t/:id; the #/t/:id hash works too.
  const shareUrl = treeId ? `${window.location.origin}/t/${treeId}` : null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  async function handleCopyLink() {
    if (!(await copyText(shareUrl))) {
      // Clipboard blocked: select the link so the reader can copy it by hand.
      urlRef.current?.select();
      setCopyFailed(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopyFailed(false), 2500);
      return;
    }
    track('link_copy', {});
    setCopyFailed(false);
    setLinkCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setLinkCopied(false), 1500);
    // A private tree is owner-only on the server, so the owner's copy flips it to unlisted.
    // Guarded on mine + private; a failed flip leaves the stance private.
    let shareable = mine && (stance === 'unlisted' || stance === 'public');
    if (mine && stance === 'private') {
      try {
        await setVisibility(treeId, 'unlisted');
        onStanceChange?.('unlisted');
        shareable = true;
      } catch { /* keep the private stance — no false promise of reach */ }
    }
    // Publishes the unfurl image, un-awaited, so it never delays or breaks the copy.
    if (shareable) onShareLink?.();
  }

  // The owner's reverse: lock the tree back to owner-only.
  async function handleMakePrivate() {
    try {
      await setVisibility(treeId, 'private');
      onStanceChange?.('private');
    } catch { /* leave the stance as it stands */ }
  }

  // The listing consent: reach doesn't move, this only decides whether the tree appears on the
  // public wall. A failed flip leaves the switch where the server is.
  async function handleListed(next) {
    try {
      await setVisibility(treeId, next ? 'public' : 'unlisted');
      onStanceChange?.(next ? 'public' : 'unlisted');
      track('gallery_listing', { listed: next });
    } catch { /* the switch springs back — never claim a listing the server didn't take */ }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Share roadmap" width={640} footer={null}>
      {shareUrl ? (
        <div key="link">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              ref={urlRef}
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
                // 16px, not smaller: iOS zooms the page into any focused input under that size.
                fontSize: 'var(--text-base)',
                color: 'var(--text-secondary)',
                outline: 'none',
                textOverflow: 'ellipsis',
              }}
            />
            <Button variant="secondary" onClick={handleCopyLink}>{linkCopied ? 'Copied' : copyFailed ? 'Press ⌘C' : 'Copy link'}</Button>
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

          {mine && (stance === 'unlisted' || stance === 'public') && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <Switch checked={stance === 'public'} onChange={handleListed} label="List in the public gallery" />
              <div style={{ marginTop: 6, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
                Puts it on <a href="/gallery" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>the gallery</a> for strangers to browse and fork. Nothing else changes — it shows exactly what your link already shows. Switch it off to unlist it again.
              </div>
            </div>
          )}

        </div>
      ) : (
        <div key="link" style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>This roadmap has no shareable link yet.</div>
      )}

      {/* The week's post: present for an owner of an editable tree, null otherwise. */}
      {weekSegment && <ProgressCardSegment {...weekSegment} />}
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
