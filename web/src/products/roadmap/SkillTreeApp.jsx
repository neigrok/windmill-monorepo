import React, { useEffect } from 'react';
import { SkillTreeView } from './SkillTreeView.jsx';
import { NewTreeBirth } from './paste/NewTreeBirth.jsx';
import { QuestShelf } from './quests/QuestShelf.jsx';
import { listAllTrees } from './persistence/TreeRegistry.js';
import { ReplicaReading } from './room/ReplicaReading.js';

// The roadmap door with no roadmap named goes to the person's newest roadmap, or to the quests where they have none: as the
// replica lists them where the room reads the device's copy, else as the server and this device's index do.
export function SkillTreeApp({ treeId, birth, start, demo = false, replica = false }) {
  useEffect(() => {
    if (birth || start || treeId) return undefined;
    const wanted = new AbortController();
    const reading = replica ? new ReplicaReading({ treeId: null }) : null;
    (reading ? reading.readList({ signal: wanted.signal }) : listAllTrees()).then((trees) => {
      reading?.close();
      if (wanted.signal.aborted) return;
      window.location.hash = trees.length > 0 ? `#/app/${trees[0].id}` : '#/app/start';
    });
    return () => {
      wanted.abort();
      reading?.close();
    };
  }, [treeId, birth, start]);

  if (start) return <QuestShelf replica={replica} />;
  if (birth) return <NewTreeBirth replica={replica} />;
  if (!treeId) return <Resolving />;
  // Keyed by treeId so per-tree state dies with the tree instead of leaking across.
  return <SkillTreeView key={treeId} treeId={treeId} demo={demo} replica={replica} />;
}

export default SkillTreeApp;

function Resolving() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-canvas)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-xl)', letterSpacing: 'var(--tracking-wide)' }}>
      Windmill
    </div>
  );
}
