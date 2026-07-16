// The app entry router (F1·F2): resolves "which tree" for the #/app family before the
// heavy tree view mounts. #/app/:treeId opens that tree; #/app/new is the birth canvas;
// bare #/app resolves against the registry — newest tree if you own any, else birth. All
// three live in the same lazy chunk as SkillTreeView, so App only parses the hash.

import React, { useEffect } from 'react';
import { SkillTreeView } from './SkillTreeView.jsx';
import { NewTreeBirth } from './ui/NewTreeBirth.jsx';
import { listTrees } from './persistence/TreeRegistry.js';

export function SkillTreeApp({ treeId, birth, openSignInSignal }) {
  // Bare #/app has no tree named: send it to the newest owned tree, or to the birth
  // canvas when the registry is empty or can't answer. Runs only while unresolved.
  useEffect(() => {
    if (birth || treeId) return undefined;
    let cancelled = false;
    listTrees().then((trees) => {
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
