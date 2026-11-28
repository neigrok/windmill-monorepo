// Gym's pictures on its landing, each drawn at the stage the shell names: the set logger, the remembered set and the
// estimated-strength line on the room's night stage, the connect card an assistant is granted on, and a routine on the
// room's own ground.

import React from 'react';
import { Check, Plus } from 'lucide-react';
import { KG, unitSymbol } from '../units.js';
import { schemeParts } from '../log.js';
import { SeedExercises } from '../domain/seedExercises.js';
import { t } from '../i18n/landing/index.js';
import './landingPictures.css';

// A scene of the room's night, 328 × 190 as the room draws it, scaled to the stage.
function NightScene({ stage, children }) {
  return (
    <div className="gyScene gym-skin" data-theme="dark" data-brand="gym" data-stage={stage}>
      <div className="gyScene-box">{children}</div>
    </div>
  );
}

export function SetLogger({ stage }) {
  return (
    <NightScene stage={stage}>
      <div className="gyLogger">
        <div className="gyLogger-chips">
          {['−10', '−2.5', '+2.5', '+10'].map((step) => <span key={step} className="gyChip">{step}</span>)}
        </div>
        <p className="gyLogger-set">
          <span className="gyLogger-weight">100<span className="gyCaption">{unitSymbol(KG)}</span></span>
          <span className="gyLogger-reps">× 5</span>
        </p>
        <p className="gyCaption gyLogger-note">{t('gym.landing.how.ladderCaption')}</p>
      </div>
    </NightScene>
  );
}

export function RememberedSet({ stage }) {
  return (
    <NightScene stage={stage}>
      <div className="gyRemembered">
        <p className="gyRemembered-head"><b>{t('gym.landing.lift.squat')}</b><span className="gyCaption">{t('gym.landing.how.rememberedDay')}</span></p>
        <p className="gyRemembered-weight">100<span className="gyCaption">{unitSymbol(KG)}</span></p>
        <p className="gyRemembered-note">{t('gym.landing.how.rememberedNote')}</p>
      </div>
    </NightScene>
  );
}

// The line's vertices on its 240 × 90 plot. Each owns the slot of the plot nearer to it than to either neighbour by x,
// and holds the room's focus ring there.
const LINE = [[8, 74], [28, 71], [48, 66], [68, 67], [88, 60], [108, 55], [128, 56], [148, 48], [168, 43], [188, 44], [208, 36], [232, 28]];
const SLOTS = LINE.map(([x, y], index) => {
  const left = index ? (LINE[index - 1][0] + x) / 2 : 0;
  const right = index < LINE.length - 1 ? (x + LINE[index + 1][0]) / 2 : 240;
  return { x, y, left, width: right - left };
});

export function StrengthLine({ stage }) {
  const [endX, endY] = LINE.at(-1);
  return (
    <NightScene stage={stage}>
      <div className="gyLine">
        <p className="gyLine-head"><span className="gyCaption">{t('gym.landing.how.lineLift')}</span><span>{t('gym.landing.how.lineWindow')}</span></p>
        <svg viewBox="0 0 240 90" width="100%" height="90">
          <path d={`M${LINE.map(([x, y]) => `${x},${y}`).join(' L')}`} />
          <circle cx={endX} cy={endY} r="3.4" />
          <g className="gyLine-plot">
            {SLOTS.map(({ x, y, left, width }) => (
              <g key={x} className="gyLine-slot">
                <rect x={left} y="0" width={width} height="90" />
                <circle className="gyLine-ring" cx={x} cy={y} r="6.8" />
              </g>
            ))}
          </g>
        </svg>
        <p className="gyCaption gyLine-note">{t('gym.landing.how.lineCaption')}</p>
      </div>
    </NightScene>
  );
}

// What an assistant connected with read and write, and not delete, was granted.
const GRANTS = [
  { scope: 'gym:read', line: t('gym.landing.connected.levelRead'), granted: true },
  { scope: 'gym:write', line: t('gym.landing.connected.levelWrite'), granted: true },
  { scope: 'gym:delete', line: t('gym.landing.connected.levelDelete'), granted: false },
];

export function ConnectCard({ stage }) {
  return (
    <div className="gyConnect gym-skin" data-theme="dark" data-brand="gym" data-stage={stage}>
      <div className="gyConnect-card">
        <p className="gyConnect-head"><span>{t('gym.landing.connected.cardTitle')}</span><span>{t('gym.landing.connected.cardProduct')}</span></p>
        <ul>
          {GRANTS.map((grant) => (
            <li key={grant.scope} className={grant.granted ? 'is-granted' : undefined}>
              <span className="gyConnect-box">{grant.granted && <Check size={11} strokeWidth={3} />}</span>
              <span className="gyConnect-scope">{grant.scope}</span>
              <span>{grant.line}</span>
            </li>
          ))}
        </ul>
        <p className="gyConnect-foot">{t('gym.landing.connected.neverGranted')}</p>
      </div>
    </div>
  );
}

// Push A as the room plans it: a ramp, the same target every set, and a target that opens with last time's load.
const ramp = [[5, 40], [4, 45], [3, 50], [2, 55], [1, 60]];
const ROUTINE = [
  { exerciseId: 'bench-press', sets: ramp.map(([reps, weightKg]) => ({ reps, weightKg })) },
  { exerciseId: 'overhead-press', sets: [8, 8, 8].map((reps) => ({ reps, weightKg: 40 })) },
  { exerciseId: 'chin-up', sets: [8, 8, 8].map((reps) => ({ reps, weightKg: null })) },
];
const nameOf = (id) => SeedExercises.all.find((exercise) => exercise.id.record === id).name;

export function Routine({ stage }) {
  return (
    <div className="gyRoutine gym-skin" data-brand="gym" data-stage={stage}>
      <div className="gyRoutine-column">
        <p className="gyRoutine-name">{t('gym.root.routine')}</p>
        <p className="gyRoutine-heading">{t('gym.routines.movementsHeading')}</p>
        <ul>
          {ROUTINE.map((entry) => (
            <li key={entry.exerciseId}>
              <span className="gyRoutine-movement">{nameOf(entry.exerciseId)}</span>
              <span className="gyRoutine-scheme">{schemeParts(entry, undefined, { unloadedFromLast: true }).map((part) => part.text).join('')}</span>
            </li>
          ))}
        </ul>
        <p className="gyRoutine-add"><Plus size={14} strokeWidth={2.2} />{t('gym.routines.addMovement')}</p>
      </div>
    </div>
  );
}
