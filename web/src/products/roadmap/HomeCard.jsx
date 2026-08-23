import React, { useEffect, useState } from 'react';
import { listTrees } from './persistence/TreeRegistry.js';

const KIND_DOT = {
  terracotta: 'var(--kind-terracotta)',
  olive: 'var(--kind-olive)',
  gold: 'var(--kind-gold)',
  brick: 'var(--kind-brick)',
  sky: 'var(--kind-sky)',
  plum: 'var(--kind-plum)',
};

// Reads only the cache keyed by the signed-in email; a ghost or unknown tab reads nothing.
function cachedTrees() {
  try {
    const hint = JSON.parse(localStorage.getItem('windmill:auth-hint') || 'null');
    if (hint?.status !== 'signed-in' || !hint.user?.email) return null;
    const rows = JSON.parse(localStorage.getItem(`windmill:trees:${hint.user.email}`) || 'null');
    return Array.isArray(rows) ? rows : null;
  } catch { return null; }
}

function tendedAgo(updatedAt) {
  if (updatedAt == null) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
}

export function HomeCard() {
  const [trees, setTrees] = useState(cachedTrees);

  useEffect(() => {
    let cancelled = false;
    listTrees().then((rows) => { if (!cancelled) setTrees(rows); });
    return () => { cancelled = true; };
  }, []);

  const newest = trees?.length ? trees[0] : null;
  const name = newest ? (newest.title?.trim() || 'Untitled roadmap') : null;
  const chars = name ? Array.from(name) : []; // cut by code points — an emoji never splits
  const shortName = chars.length > 18 ? `${chars.slice(0, 17).join('').trimEnd()}…` : name;
  const tended = newest ? tendedAgo(newest.updatedAt) : null;

  return (
    <>
      <style>{CSS}</style>
      <a className="wm-rhc" href={newest ? `#/app/${newest.id}` : '#/app/start'}>
        <span className="wm-rhc-head">
          <span className="wm-rhc-dot" style={{ background: KIND_DOT[newest?.dominantKind] ?? KIND_DOT.terracotta }} aria-hidden="true" />
          Roadmap
        </span>
        {newest ? (
          <span className="wm-rhc-body">
            {name}{' · '}
            <span className="wm-rhc-mono">{`${newest.done ?? 0}/${newest.total ?? 0}`}</span>
            {' done'}{tended ? ` · last tended ${tended}` : ''}
          </span>
        ) : (
          <span className="wm-rhc-body">No account needed — your first tree lives in your browser.</span>
        )}
        <span className="wm-rhc-link">{newest ? `Resume ${shortName} →` : 'Start your tree →'}</span>
      </a>
    </>
  );
}

export default HomeCard;

const CSS = `
  .wm-rhc { display:flex; flex-direction:column; gap:8px; text-align:left; box-sizing:border-box;
            background:var(--surface-card); border:1px solid var(--border-subtle); border-radius:var(--radius-xl);
            padding:20px 22px; box-shadow:var(--shadow-sm); text-decoration:none; cursor:pointer;
            transition:box-shadow 150ms var(--ease-standard), transform 150ms var(--ease-standard); }
  .wm-rhc:hover { box-shadow:var(--shadow-md); }
  .wm-rhc:active { transform:scale(0.97); }
  .wm-rhc-head { display:flex; align-items:center; gap:9px; font-family:var(--font-display);
                 font-weight:700; font-size:17px; color:var(--text-primary); }
  .wm-rhc-dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .wm-rhc-body { font-family:var(--font-body); font-size:14px; line-height:1.5; color:var(--text-secondary); }
  .wm-rhc-mono { font-family:var(--font-mono); color:var(--text-primary); }
  .wm-rhc-link { font-weight:700; font-size:13.5px; color:var(--text-link); }

  @media (prefers-reduced-motion: reduce) { .wm-rhc { transition:none; } .wm-rhc:active { transform:none; } }
`;
