import React from 'react';
import { GalleryCard } from '../share/GalleryCard.jsx';
import { cardMark } from './galleryIndex.js';
import { portraitUrl } from './GalleryClient.js';

export function BrowseCard({ entry, forking, failed, onFork }) {
  const mark = cardMark(entry);

  return (
    <GalleryCard
      className="wm-br-card"
      width="100%"
      title={entry.title}
      stats={entry.stats}
      dominantKind={entry.dominantKind}
      portrait={portraitUrl(entry.id)}
      href={mark.href}
      badge={mark.badge}
    >
      <span className="wm-br-lineage">{failed ? "Couldn't fork just now" : lineageOf(entry)}</span>
      <span className="wm-br-fork">
        {mark.fork === 'offer' && (
          <button type="button" className="wm-br-forkbtn" onClick={() => onFork(entry)} disabled={forking}>
            {forking ? 'Forking…' : 'Fork'}
          </button>
        )}
        {mark.fork === 'copy' && <a className="wm-br-open" href={`#/app/${entry.copyId}`}>Open your copy</a>}
      </span>
    </GalleryCard>
  );
}

function lineageOf(entry) {
  const phrases = [];
  if (entry.forks > 0) phrases.push(`forked ${entry.forks} ${entry.forks === 1 ? 'time' : 'times'}`);
  if (entry.sourceTitle) phrases.push(`A fork of “${entry.sourceTitle}”`);
  return phrases.join(' · ');
}

export const BROWSE_CARD_CSS = `
  .wm-br-card { transition:transform var(--duration-base) var(--ease-soft),
                           box-shadow var(--duration-base) var(--ease-soft),
                           border-color var(--duration-base) var(--ease-soft);
                animation:wm-br-arrive 150ms linear both; }
  .wm-br-card:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); }
  /* Arrival: a flat 150ms cross-fade — no rise, no pop, no stagger, so a page lands as one page. */
  @keyframes wm-br-arrive { from { opacity:0; } to { opacity:1; } }

  .wm-br-lineage { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                   font-family:var(--font-body); font-size:11px; font-weight:600; color:var(--text-tertiary); }
  .wm-br-fork { margin-left:auto; flex:none; opacity:0; transition:opacity 150ms var(--ease-standard); }
  .wm-br-card:hover .wm-br-fork, .wm-br-card:focus-within .wm-br-fork { opacity:1; }
  /* No hover to reveal it: below 1024 and on any touch pointer the fork is simply there. */
  @media (max-width: 1023px), (hover: none) { .wm-br-fork { opacity:1; } }

  .wm-br-forkbtn { position:relative; font-family:var(--font-body); font-size:11.5px; font-weight:800;
                   color:var(--text-on-accent); background:var(--color-brand); border:none;
                   border-radius:var(--radius-full); padding:6px 14px; cursor:pointer;
                   transition:background 150ms var(--ease-standard); }
  .wm-br-forkbtn:hover { background:var(--color-brand-hover); }
  .wm-br-forkbtn:disabled { background:var(--neutral-300); cursor:default; }
  .wm-br-open { position:relative; font-family:var(--font-body); font-size:11.5px; font-weight:800;
                color:var(--text-link); text-decoration:none; padding:6px 2px; }
  .wm-br-open:hover { color:var(--text-link-hover); }

  @media (prefers-reduced-motion: reduce) {
    .wm-br-card { transition:none; }
    .wm-br-card:hover { transform:none; box-shadow:var(--shadow-sm); }
  }
`;
