// The in-product public wall (#/browse) — the client-rendered twin of windmill.works/gallery.
// One index, one ranking, two readers: this one knows you, so a card wears your relationship
// to the tree and carries the fork itself (canon §3). Never a nav item and never above your
// own trees — you arrive here from the shelf at the end of your gallery, and the way back is
// the plaque.
//
// The loading grammar is the whole reason this surface needed a design (canon §4): nothing at
// all for 400ms, because a loader that flashes is worse than none; then a skeleton at the
// card's exact height; then a flat 150ms cross-fade as the real cards land in the same boxes.
// Chrome — plaque, header, buttons — is never skeletonised and paints immediately. No spinners.

import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useViewMode } from '../ui/useViewMode.js';
import { forkTree } from '../persistence/TreeRegistry.js';
import { GalleryCard, GALLERY_CARD_CSS } from '../share/GalleryCard.jsx';
import { ForkDoor } from '../ui/mobile/ForkDoor.jsx';
import { track } from '../../telemetry/beacon.js';
import { GalleryIndex, galleryHeader } from './galleryIndex.js';
import { fetchGallery } from './GalleryClient.js';
import { BrowseCard, BROWSE_CARD_CSS } from './BrowseCard.jsx';

const SKELETON_AFTER_MS = 400;
const ARRIVAL_MS = 150;
const SKELETON_CARDS = [0, 1, 2, 3, 4, 5]; // the rack fills the first screen; CSS hides the rows a narrower one doesn't have

export function BrowsePage() {
  const { user, status } = useAuth();
  const { breakpoint } = useViewMode();
  const [index, setIndex] = useState(() => new GalleryIndex());
  const [skeleton, setSkeleton] = useState('hidden'); // hidden | shown | leaving
  const [attempt, setAttempt] = useState(0);
  const [forkingId, setForkingId] = useState('');
  const [forkFailedId, setForkFailedId] = useState('');
  const [doorFor, setDoorFor] = useState('');

  const signedIn = status === 'signed-in' && Boolean(user);

  useEffect(() => {
    let live = true;
    const reveal = setTimeout(() => { if (live) setSkeleton('shown'); }, SKELETON_AFTER_MS);
    fetchGallery()
      .then((page) => {
        clearTimeout(reveal);
        if (!live) return;
        setIndex((current) => current.join(page));
        // A page that beat the 400ms mark never had a skeleton to cross-fade from; one that
        // didn't hands its boxes over to the arriving cards.
        setSkeleton((current) => (current === 'shown' ? 'leaving' : 'hidden'));
      })
      .catch(() => {
        clearTimeout(reveal);
        if (!live) return;
        setIndex((current) => current.failed());
        setSkeleton('hidden');
      });
    return () => { live = false; clearTimeout(reveal); };
  }, [attempt]);

  useEffect(() => {
    if (skeleton !== 'leaving') return undefined;
    const settled = setTimeout(() => setSkeleton('hidden'), ARRIVAL_MS);
    return () => clearTimeout(settled);
  }, [skeleton]);

  function showMore() {
    if (!index.hasMore || index.status === 'paging') return;
    setIndex(index.paging());
    fetchGallery({ cursor: index.cursor })
      .then((page) => setIndex((current) => current.join(page)))
      .catch(() => setIndex((current) => current.failed()));
  }

  // Retry means "ask again for what didn't arrive": a page that failed mid-walk resumes from
  // its cursor and keeps the trees already on screen; a first page that never landed starts the
  // whole load over, 400ms silence and all.
  function retry() {
    if (index.hasMore) {
      showMore();
      return;
    }
    setIndex(new GalleryIndex());
    setSkeleton('hidden');
    setAttempt((n) => n + 1);
  }

  // One click, on the card. Signed in it plants the copy and the card flips to "Forked" —
  // you stay on the wall, which is the only way "can't be forked twice by accident" can mean
  // anything. Signed out there is no session to own a copy, so the email door finishes it.
  async function fork(entry) {
    setForkFailedId('');
    if (!signedIn) { setDoorFor(entry.id); return; }
    if (forkingId) return;
    setForkingId(entry.id);
    track('fork_attempt', { mode: 'browse' });
    try {
      const { treeId } = await forkTree(entry.id);
      track('fork_claim', { mode: 'browse' });
      setIndex((current) => current.forked(entry.id, treeId));
    } catch (error) {
      if (error?.code === 'unauthenticated') setDoorFor(entry.id);
      else setForkFailedId(entry.id);
    } finally {
      setForkingId('');
    }
  }

  // Canon §5 gates the Popular · New · Finished chips at 24 listed trees and search at 100.
  // `header.chips` and `header.search` are the record of those numbers; neither control is
  // built while the index is in single digits, and this line is where they will mount.
  const header = galleryHeader(index.count);

  return (
    <div className="wm-br">
      <style>{GALLERY_CARD_CSS + BROWSE_CARD_CSS + CSS}</style>

      <a className="wm-br-plaque" href="#/app" title="Your trees">
        <span className="wm-br-glyph">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 20v-8" /><path d="M12 12c0-3 2-5 6-5 0 3-2 5-6 5z" /><path d="M12 14c0-2.5-1.7-4-5-4 0 2.5 1.7 4 5 4z" /></svg>
        </span>
        <span className="wm-br-wordmark">Windmill</span>
      </a>

      <main className="wm-br-main">
        <h1 className="wm-br-title">Planted in public</h1>
        <p className="wm-br-sub">
          Plans people chose to list, ranked by the forks they have inspired. Open one to see how far it has
          got — or fork it and make the plan yours.
        </p>
        <p className="wm-br-line">
          {header.line && <><span>{header.line}</span><i className="wm-br-sep" /></>}
          <a href="/gallery">How a tree gets here</a>
        </p>

        <div className="wm-br-stage">
          {index.entries.length > 0 && (
            <div className="wm-br-grid">
              {index.entries.map((entry) => (
                <BrowseCard
                  key={entry.id}
                  entry={entry}
                  forking={forkingId === entry.id}
                  failed={forkFailedId === entry.id}
                  onFork={fork}
                />
              ))}
            </div>
          )}

          {skeleton !== 'hidden' && (
            <div className={`wm-br-grid wm-br-skel${skeleton === 'leaving' ? ' is-leaving' : ''}`} aria-hidden="true">
              {SKELETON_CARDS.map((slot) => <GalleryCard key={slot} loading width="100%" />)}
            </div>
          )}
        </div>

        {index.isBare && (
          <div className="wm-br-bare">
            <h2>Nothing on the wall yet</h2>
            <p>
              Listing is a deliberate choice — sharing a link keeps a tree unlisted, and putting one here is a
              separate yes. Yours could be the first.
            </p>
            {/* The line above already carries "How a tree gets here"; what a bare wall is missing
                is a tree, so the invitation is the door to planting one. */}
            <a href="#/app/new">Plant a tree</a>
          </div>
        )}

        {/* Paging is a button, not an endless scroll: the wall is a shelf you can reach the end
            of, and an infinite feed is the body language canon §7 rules out. */}
        {index.status === 'failed' ? (
          <div className="wm-br-quiet">
            <p>Can’t reach the gallery just now.</p>
            <button type="button" className="wm-br-more" onClick={retry}>Try again</button>
          </div>
        ) : index.hasMore ? (
          <div className="wm-br-quiet">
            <button type="button" className="wm-br-more" onClick={showMore} disabled={index.status === 'paging'}>
              {index.status === 'paging' ? 'Loading…' : 'Show more trees'}
            </button>
          </div>
        ) : null}
      </main>

      <ForkDoor
        open={Boolean(doorFor)}
        tablet={breakpoint !== 'phone'}
        treeId={doorFor}
        signedIn={false}
        onClose={() => setDoorFor('')}
      />
    </div>
  );
}

export default BrowsePage;

const CSS = `
  .wm-br { position:fixed; inset:0; overflow-y:auto; background:var(--surface-canvas);
           font-family:var(--font-body); color:var(--text-primary); }
  .wm-br-plaque { position:sticky; top:var(--space-6); margin-left:var(--space-6); z-index:5;
                  display:inline-flex; align-items:center; gap:var(--space-2);
                  padding:var(--space-2) var(--space-3); text-decoration:none; color:inherit;
                  background:color-mix(in srgb, var(--surface-card) 88%, transparent);
                  border:1px solid var(--border-subtle); border-radius:var(--radius-full);
                  box-shadow:var(--shadow-sm); }
  .wm-br-glyph { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px;
                 border-radius:50%; background:var(--color-brand-soft); color:var(--color-brand-hover); }
  .wm-br-wordmark { font-family:var(--font-display); font-weight:800; font-size:var(--text-base); }

  .wm-br-main { max-width:1080px; margin:0 auto; padding:var(--space-8) var(--space-6) var(--space-10); }
  .wm-br-title { font-family:var(--font-display); font-weight:700; font-size:clamp(26px, 3.4vw, 34px);
                 margin:var(--space-6) 0 var(--space-2); }
  .wm-br-sub { max-width:620px; font-size:var(--text-base); line-height:1.6; color:var(--text-secondary); margin:0; }
  .wm-br-line { display:flex; align-items:center; gap:8px; font-size:var(--text-sm); font-weight:700;
                color:var(--text-tertiary); margin:var(--space-3) 0 var(--space-6); }
  .wm-br-line a { color:var(--text-link); text-decoration:none; font-weight:700; }
  .wm-br-line a:hover { color:var(--text-link-hover); }
  .wm-br-sep { width:3px; height:3px; border-radius:50%; background:var(--border-default); flex:none; }

  /* X5 §8's grid: one column, 2-up from 744, 3-up from 1180 — the 1080 column keeps every
     card past 320px wide at every step. */
  .wm-br-stage { position:relative; }
  .wm-br-grid { display:grid; grid-template-columns:1fr; gap:20px; }
  @media (min-width: 744px)  { .wm-br-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1180px) { .wm-br-grid { grid-template-columns:repeat(3, minmax(0, 1fr)); } }

  /* The skeleton rack fills the screen it is on and no more: two cards on a phone, four on a
     tablet, six on a desktop — the rows a reader would actually see wait for content. */
  .wm-br-skel > *:nth-child(n+3) { display:none; }
  @media (min-width: 744px)  { .wm-br-skel > *:nth-child(3), .wm-br-skel > *:nth-child(4) { display:block; } }
  @media (min-width: 1180px) { .wm-br-skel > *:nth-child(5), .wm-br-skel > *:nth-child(6) { display:block; } }
  /* Arrival: the rack lifts out of flow so the cards keep its exact boxes, and the two
     layers cross-fade over 150ms. */
  .wm-br-skel.is-leaving { position:absolute; left:0; right:0; top:0; opacity:0; pointer-events:none;
                           transition:opacity ${ARRIVAL_MS}ms linear; }

  .wm-br-bare { border:1px dashed var(--border-default); border-radius:var(--radius-xl);
                padding:var(--space-8) var(--space-6); text-align:center; }
  .wm-br-bare h2 { font-family:var(--font-display); font-weight:700; font-size:var(--text-xl); margin:0; }
  .wm-br-bare p { max-width:430px; margin:10px auto 0; font-size:var(--text-sm); line-height:1.65; color:var(--text-secondary); }
  .wm-br-bare a { display:inline-block; margin-top:var(--space-4); font-size:var(--text-sm); font-weight:700;
                  color:var(--text-link); text-decoration:none; }

  .wm-br-quiet { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:var(--space-6); }
  .wm-br-quiet p { margin:0; font-size:var(--text-sm); color:var(--text-tertiary); }
  .wm-br-more { font-family:var(--font-body); font-size:var(--text-sm); font-weight:800; color:var(--text-primary);
                background:var(--surface-card); border:1px solid var(--border-default); border-radius:var(--radius-full);
                padding:9px 20px; cursor:pointer; transition:background 150ms var(--ease-standard); }
  .wm-br-more:hover { background:var(--surface-hover); }
  .wm-br-more:disabled { color:var(--text-tertiary); cursor:default; }
`;
