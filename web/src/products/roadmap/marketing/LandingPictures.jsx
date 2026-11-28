// Roadmap's pictures on its landing, each drawn at the stage the shell names: the sail tree on the page's ground, a
// step finishing and the steps it opens, the ready paths, a step's page, and a published tree with its fork.

import React from 'react';
import { Check } from 'lucide-react';
import { Icon } from '../../../design-system';
import { KIND_CSS } from '../theme.js';
import { QuestThumb } from '../quests/QuestThumb.jsx';
import { ROSTER } from '../quests/roster.js';
import { ComposedTree, SAIL, SAIL_NARROW, SAIL_WIDE, stretched } from './ComposedTree.jsx';
import { t } from '../i18n/landing/index.js';
import './landingPictures.css';

// The sail tree across the frame, and on a phone the nine steps stood taller under the plaque.
const HERO = {
  wide: stretched(SAIL_WIDE, { width: 1310, height: 605, x: (at) => 193 + (at - 48) * 1.625, y: (down) => 300 + (down - 175) * 1.55 }),
  narrow: stretched(SAIL_NARROW, { width: 356, height: 376, plaque: true, x: (at) => at + 15, y: (down) => 96 + (down - 47) * 2 }),
};

export function HeroTree({ stage }) {
  return (
    <div className="rmHero" data-stage={stage}>
      <ComposedTree world={HERO[stage]} />
      {stage === 'wide' && <span className="rmHero-toast">{t('roadmap.step.completedOutcomeMany', { count: 2, shown: '2' })}</span>}
    </div>
  );
}

// The room's unlock: Rig the mast finished, and the two steps that waited on it open. Only the finished beat plays the
// unlock when the pointer arrives, so the picture holds one ceremony.
const BEAT = { width: 320, height: 190, plaque: false, size: { done: 26, avail: 22, dim: 22 },
  seats: { rig: [84, 98], trim: [236, 46], points: [248, 148] }, edges: [['rig', 'trim'], ['rig', 'points']] };
const beatSteps = (finished) => ({
  rig: { name: t('roadmap.scene.rigMast'), kind: 'terracotta', done: finished },
  trim: { name: t('roadmap.scene.sailTrim'), kind: 'terracotta' },
  points: { name: t('roadmap.scene.pointsOfSail'), kind: 'sky' },
});

function Beat({ finished }) {
  return (
    <div className="rmBeat">
      <div className="rmBeat-world"><ComposedTree world={BEAT} steps={beatSteps(finished)} needs={BEAT.edges} arrival={finished ? 'unlock' : null} /></div>
      <p className="rmBeat-caption">{finished
        ? t('roadmap.step.completedOutcomeMany', { count: 2, shown: '2' })
        : t('roadmap.step.finishToUnlock', { step: t('roadmap.scene.rigMast') })}</p>
    </div>
  );
}

export function UnlockStages({ stage }) {
  return (
    <div className="rmUnlock" data-stage={stage}>
      <Beat finished={false} />
      <span className="rmUnlock-arrow"><Icon name="arrow-right" size={20} strokeWidth={1.6} /></span>
      <Beat finished />
    </div>
  );
}

// The four ready paths for developers, as the room's shelf shows them.
const DEVELOPER_PATHS = ROSTER.filter((quest) => quest.group === 'dev');

export function PathCards({ stage }) {
  return (
    <div className="rmPaths" data-stage={stage}>
      {(stage === 'narrow' ? [DEVELOPER_PATHS[0], DEVELOPER_PATHS.at(-1)] : DEVELOPER_PATHS).map((quest) => (
        <div key={quest.id} className="rmPaths-card">
          <span className="rmPaths-rule" style={{ background: KIND_CSS[quest.kinds[0].hue].base }} />
          <span className="rmPaths-thumb"><QuestThumb quest={quest} /></span>
          <span className="rmPaths-meta">
            <span>
              <b className="rmPaths-title">{quest.title}</b>
              <span className="rmPaths-readout">{t('roadmap.quests.readout', { count: quest.nodes.length, estimate: quest.estimate })}</span>
            </span>
            <span className="rmPaths-dots">{quest.kinds.map((kind) => <i key={kind.id} style={{ background: KIND_CSS[kind.hue].base }} />)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// A step's page: what it requires and opens, and the workspace that is only the owner's.
const SUBTASKS = [
  { text: t('roadmap.scene.subtaskCourse'), done: true },
  { text: t('roadmap.scene.subtaskCross'), done: true },
  { text: t('roadmap.scene.subtaskChain'), done: false },
];

export function StepPanel({ stage }) {
  return (
    <div className="rmStep" data-stage={stage}>
      <div className="rmStep-panel">
        <p className="rmStep-state"><i />{t('roadmap.column.upNext')}</p>
        <p className="rmStep-name">{t('roadmap.scene.stepName')}</p>
        <p className="rmStep-about">{t('roadmap.scene.stepAbout')}</p>
        <dl className="rmStep-links">
          <div><dt>{t('roadmap.step.requires')}</dt><dd>{t('roadmap.step.requiresDone', { done: 2, total: 2 })}</dd></div>
          <div><dt>{t('roadmap.step.opens')}</dt><dd>{t('roadmap.step.opensCount', { count: 1 })}</dd></div>
        </dl>
        <p className="rmStep-workspace">{t('roadmap.step.myWorkspace')}<span>{t('roadmap.step.onlyYou')}</span></p>
        <ul className="rmStep-subtasks">
          {SUBTASKS.map((subtask) => (
            <li key={subtask.text} className={subtask.done ? 'is-done' : undefined}>
              <span className="rmStep-box">{subtask.done && <Check size={12} strokeWidth={3} />}</span>{subtask.text}
            </li>
          ))}
        </ul>
        <p className="rmStep-tally">{t('roadmap.step.subtaskTally', { done: 2, total: 3 })}</p>
        <div className="rmStep-note"><b>{t('roadmap.workspace.note')}</b><p>{t('roadmap.scene.stepNote')}</p></div>
        <span className="rmStep-complete">{t('roadmap.step.complete')}</span>
      </div>
    </div>
  );
}

// The published tree a reader sees, and the room's Fork this tree under it.
const FORK_WIDE = stretched(SAIL_NARROW, { width: 520, height: 200, x: (at) => 34 + (at - 34) * 1.595 });

export function ForkTree({ stage }) {
  return (
    <div className="rmFork" data-stage={stage}>
      <div className="rmFork-tree"><ComposedTree steps={SAIL} world={stage === 'wide' ? FORK_WIDE : SAIL_NARROW} /></div>
      <span className="rmFork-pill">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="4.6" r="2.5" /><circle cx="5.4" cy="19.4" r="2.5" /><circle cx="18.6" cy="19.4" r="2.5" />
          <path d="M12 7.1v3.2M12 10.3c0 3-6.6 3.4-6.6 6.6M12 10.3c0 3 6.6 3.4 6.6 6.6" />
        </svg>
        {t('roadmap.scene.fork')}
      </span>
    </div>
  );
}
