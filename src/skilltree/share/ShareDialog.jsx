// The Share surface (X2 identity), in two segments. The first shares the TREE: a copyable share
// URL and the tree's sharing stance. Copying a private tree's link flips it to unlisted so the
// recipient can view; the owner can lock it back to private. Its one image is the unfurl card
// (brief #12), published in the background via onShareLink when the owner shares, never previewed
// or downloaded here. The second segment shares a POST — this week of the tree, as a picture
// (brief #20) — and is the door anyone who declined the offer comes back through.
//
// The three stances are two decisions, not one scale. Private→unlisted is REACH, and copying
// the link makes it. Unlisted→public is LISTING, a separate consent the owner gives on purpose
// below — because "anyone with the link can view" and "put my plan on a wall strangers browse"
// are different things to agree to, and only the second one puts a tree in /gallery.

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button, Switch } from '../../components';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { track } from '../../telemetry/beacon.js';
import { ProgressCardSegment } from './ProgressCardSegment.jsx';

// `stance` is the caller's — the view that loaded the tree owns the server's answer, and every
// flip made here is reported back through onStanceChange rather than mirrored in local state.
// A dialog that kept its own copy would go stale the moment it closed: reopening it would show
// the stance the page loaded with, not the one the owner just chose.
export function ShareDialog({ open, onClose, visibility, mine, onShareLink, onStanceChange, weekSegment = null }) {
  const [linkCopied, setLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false); // clipboard denied — the link is still selectable
  const copiedTimer = useRef(null);
  const urlRef = useRef(null);

  const stance = visibility ?? null;
  const treeId = treeIdFromHash(window.location.hash);
  // The real, indexable share URL: a shared tree lives at /t/:id, where the backend unfurls
  // its own title and description for social scrapers (the #/t/:id hash still works too).
  const shareUrl = treeId ? `${window.location.origin}/t/${treeId}` : null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  async function handleCopyLink() {
    if (!(await copyText(shareUrl))) {
      // Clipboard blocked (insecure context / denied). Surface the link instead of
      // failing silently: select it and tell the reader to copy it by hand.
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
    // A private tree is owner-only on the server, so its copied link would 404 for the
    // recipient. When the owner shares, flip it to unlisted — anyone with the link can then
    // view. Guarded on mine + private so a non-owner's call never fires (it would 403) and a
    // public tree is never lowered. If the flip fails the link still copied; the stance stays
    // private, so the dialog never claims a reach the server won't honor.
    let shareable = mine && (stance === 'unlisted' || stance === 'public');
    if (mine && stance === 'private') {
      try {
        await setVisibility(treeId, 'unlisted');
        onStanceChange?.('unlisted');
        shareable = true;
      } catch { /* keep the private stance — no false promise of reach */ }
    }
    // The owner just made their own tree reachable — publish its unfurl image (the tree as
    // itself). Fired without await and best-effort inside, so it never delays or breaks the copy.
    if (shareable) onShareLink?.();
  }

  // The owner's deliberate reverse: lock the tree back to owner-only. Its link goes dark, and
  // the stance line retreats with it.
  async function handleMakePrivate() {
    try {
      await setVisibility(treeId, 'private');
      onStanceChange?.('private');
    } catch { /* leave the stance as it stands */ }
  }

  // The listing consent. Reach doesn't move — unlisted and public read identically to anyone
  // holding the link — so this only decides whether the tree appears on the public wall, and
  // it un-decides as easily. A failed flip leaves the switch where the server actually is.
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
                fontSize: 'var(--text-sm)',
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

      {/* The second segment — the week's post. Present for an owner of an editable tree; a tree
          that isn't yours passes null and the sheet stays the link surface it has always been. */}
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
