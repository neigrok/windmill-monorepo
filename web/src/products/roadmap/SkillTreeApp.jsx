// The app entry router (F1·F2): resolves "which tree" for the #/app family before the
// heavy tree view mounts. #/app/:treeId opens that tree; #/app/new is the birth canvas;
// #/app/start is the quest shelf (F5); bare #/app resolves against the union of the
// account's trees and this device's local ones (anon-first-tree F3) — newest first, the
// shelf when both are empty. All four live in the same lazy chunk as SkillTreeView, so
// App only parses the hash.

import React, { useEffect } from 'react';
import { SkillTreeView } from './SkillTreeView.jsx';
import { NewTreeBirth } from './ui/NewTreeBirth.jsx';
import { QuestShelf } from './quests/QuestShelf.jsx';
import { listAllTrees } from './persistence/TreeRegistry.js';

export function SkillTreeApp({ treeId, birth, start, demo = false }) {
  // Bare #/app has no tree named: send it to the newest tree of the union — server or
  // local — or to the quest shelf when there is none. Runs only while unresolved.
  useEffect(() => {
    if (birth || start || treeId) return undefined;
    let cancelled = false;
    listAllTrees().then((trees) => {
      if (cancelled) return;
      window.location.hash = trees.length > 0 ? `#/app/${trees[0].id}` : '#/app/start';
    });
    return () => { cancelled = true; };
  }, [treeId, birth, start]);

  if (start) return <QuestShelf />;
  if (birth) return <NewTreeBirth />;
  if (!treeId) return <Resolving />;
  // A different tree is a different world: keying by treeId lets demotion, lapse,
  // fork state, and the scene's mode die with the old tree instead of leaking across.
  return <SkillTreeView key={treeId} treeId={treeId} demo={demo} />;
}

export default SkillTreeApp;

function Resolving() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-canvas)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-xl)', letterSpacing: 'var(--tracking-wide)' }}>
      Windmill
    </div>
  );
}
