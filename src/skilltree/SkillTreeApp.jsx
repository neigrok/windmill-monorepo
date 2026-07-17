// The app entry router (F1·F2): resolves "which tree" for the #/app family before the
// heavy tree view mounts. #/app/:treeId opens that tree; #/app/new is the birth canvas;
// bare #/app resolves against the union of the account's trees and this device's local
// ones (anon-first-tree F3) — newest first, birth when both are empty. All three live
// in the same lazy chunk as SkillTreeView, so App only parses the hash.

import React, { useEffect } from 'react';
import { SkillTreeView } from './SkillTreeView.jsx';
import { NewTreeBirth } from './ui/NewTreeBirth.jsx';
import { listAllTrees } from './persistence/TreeRegistry.js';

export function SkillTreeApp({ treeId, birth, openSignInSignal }) {
  // Bare #/app has no tree named: send it to the newest tree of the union — server or
  // local — or to the birth canvas when there is none. Runs only while unresolved.
  useEffect(() => {
    if (birth || treeId) return undefined;
    let cancelled = false;
    listAllTrees().then((trees) => {
      if (cancelled) return;
      window.location.hash = trees.length > 0 ? `#/app/${trees[0].id}` : '#/app/new';
    });
    return () => { cancelled = true; };
  }, [treeId, birth]);

  if (birth) return <NewTreeBirth />;
  if (!treeId) return <Resolving />;
  // A different tree is a different world: keying by treeId lets demotion, lapse,
  // fork state, and the scene's mode die with the old tree instead of leaking across.
  return <SkillTreeView key={treeId} treeId={treeId} openSignInSignal={openSignInSignal} />;
}

export default SkillTreeApp;

function Resolving() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-canvas)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-xl)', letterSpacing: 'var(--tracking-wide)' }}>
      Windmill
    </div>
  );
}
