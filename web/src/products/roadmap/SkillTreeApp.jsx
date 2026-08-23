import React, { useEffect } from 'react';
import { SkillTreeView } from './SkillTreeView.jsx';
import { NewTreeBirth } from './ui/NewTreeBirth.jsx';
import { QuestShelf } from './quests/QuestShelf.jsx';
import { listAllTrees } from './persistence/TreeRegistry.js';

export function SkillTreeApp({ treeId, birth, start, demo = false }) {
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
  // Keyed by treeId so per-tree state dies with the tree instead of leaking across.
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
