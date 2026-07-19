// The Share surface (X2 identity), link-only: a copyable share URL and the tree's
// sharing stance. Copying a private tree's link flips it to unlisted so the recipient
// can view; the owner can lock it back to private. The link is the whole surface here —
// the one image is the unfurl card (brief #12), published in the background via onShareLink
// when the owner shares, never previewed or downloaded in the dialog.

import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button } from '../../components';
import { setVisibility } from '../persistence/TreeRegistry.js';
import { beginUpgrade, billingConfigured } from '../billing/checkout.js';
import { track } from '../../telemetry/beacon.js';

export function ShareDialog({ open, onClose, visibility, mine, onShareLink }) {
  const [linkCopied, setLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false); // clipboard denied — the link is still selectable
  // The tree's live sharing stance. Seeded from the server's answer, but the owner's copy-link
  // flip and the Make-private toggle move it here without a reload — so the dialog's stance line
  // always states the reach the server actually holds, never a stale prop.
  const [stance, setStance] = useState(visibility ?? null);
  // The server's "that one's part of Pro" answer, held so the dialog can explain the refusal and
  // offer the way through. Null whenever nothing is being refused.
  const [gate, setGate] = useState(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeFailed, setUpgradeFailed] = useState(false);
  const copiedTimer = useRef(null);
  const urlRef = useRef(null);

  const treeId = treeIdFromHash(window.location.hash);
  // The real, indexable share URL: a shared tree lives at /t/:id, where the backend unfurls
  // its own title and description for social scrapers (the #/t/:id hash still works too).
  const shareUrl = treeId ? `${window.location.origin}/t/${treeId}` : null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Re-seed the stance whenever the server's answer changes or the dialog reopens, so a
  // reload's fresh visibility replaces any flip we made in a prior opening.
  useEffect(() => {
    setStance(visibility ?? null);
    setGate(null);
    setUpgradeFailed(false);
  }, [visibility, open]);

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
        setStance('unlisted');
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
    setGate(null);
    try {
      await setVisibility(treeId, 'private');
      setStance('private');
    } catch (error) {
      // Private roadmaps are the paid line, so a free account's click is a gate, not a fault — the
      // one refusal here worth explaining, in the server's own words. Anything else (offline, a
      // stale session) leaves the stance exactly as it stands, as it always has.
      if (error?.code === 'pro_required') setGate({ title: error.message, detail: error.detail });
    }
  }

  // Upgrading from here means the reader wanted this tree private, so finish that for them rather
  // than leaving them to find the toggle again once the payment clears.
  async function handleUpgrade() {
    setUpgrading(true);
    if (!(await beginUpgrade({ onCompleted: handleMakePrivate }))) setUpgradeFailed(true);
    setUpgrading(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title="Share roadmap" width={640} footer={null}>
      {shareUrl ? (
        <div>
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

          {gate && (
            <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1.5px solid var(--border-default)', background: 'var(--surface-sunken, var(--surface-card))', fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)' }}>
              <div style={{ color: 'var(--text-secondary)' }}>{gate.title}</div>
              {gate.detail && <div style={{ marginTop: 4, color: 'var(--text-tertiary)' }}>{gate.detail}</div>}
              {billingConfigured() && (
                <div style={{ marginTop: 10 }}>
                  <Button variant="primary" onClick={handleUpgrade} disabled={upgrading}>
                    {upgrading ? 'Opening…' : 'Upgrade to Pro'}
                  </Button>
                  {/* Nobody should be asked to pay without being told the price first. */}
                  <div style={{ marginTop: 8, color: 'var(--text-tertiary)', fontSize: 'var(--text-xs, 12px)' }}>
                    $12 a month · cancel any time · <a href="/pricing.html" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>what’s included</a>
                  </div>
                </div>
              )}
              {upgradeFailed && (
                <div style={{ marginTop: 8, color: 'var(--text-tertiary)' }}>Checkout wouldn’t open. Try again, or upgrade from Settings.</div>
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
