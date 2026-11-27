// A still tree for the site's pictures, drawn in the room's node vocabulary and by the room's rule: a step not done
// is available once every step it needs is done and locked before, and every edge out of a done step is lit. A world
// places the steps it shows; the steps and what each needs come from the step book it is drawn with.

import React from 'react';
import { Icon } from '../../../design-system';
import { KIND_CSS } from '../theme.js';
import { t } from '../i18n/entry/index.js';
import './composedTree.css';

// The sail tree every picture of Learn to sail draws, and the steps finished in it.
export const SAIL = {
  root:     { name: t('roadmap.scene.learnToSail'), kind: 'terracotta', done: true },
  knots:    { name: t('roadmap.scene.knotsLines'), kind: 'gold', done: true },
  rig:      { name: t('roadmap.scene.rigMast'), kind: 'terracotta', done: true },
  wind:     { name: t('roadmap.scene.readWind'), kind: 'sky', done: true },
  docking:  { name: t('roadmap.scene.docking'), kind: 'olive' },
  capsize:  { name: t('roadmap.scene.capsizeDrill'), kind: 'plum' },
  whipping: { name: t('roadmap.scene.whippingSplicing'), kind: 'gold' },
  cleats:   { name: t('roadmap.scene.cleatsHitches'), kind: 'gold', done: true },
  trim:     { name: t('roadmap.scene.sailTrim'), kind: 'terracotta', done: true },
  points:   { name: t('roadmap.scene.pointsOfSail'), kind: 'sky' },
  weather:  { name: t('roadmap.scene.weatherWindows'), kind: 'sky' },
  night:    { name: t('roadmap.scene.nightDocking'), kind: 'olive' },
  overboard: { name: t('roadmap.scene.manOverboard'), kind: 'terracotta' },
  reefing:  { name: t('roadmap.scene.reefing'), kind: 'terracotta' },
  tides:    { name: t('roadmap.scene.tidesCurrents'), kind: 'sky' },
  firstAid: { name: t('roadmap.scene.firstAidAfloat'), kind: 'plum' },
  solo:     { name: t('roadmap.scene.firstSoloSail'), kind: 'plum' },
};

// What each sail step needs; every world draws a part of this one graph.
export const SAIL_NEEDS = [
  ['root', 'knots'], ['root', 'rig'], ['root', 'wind'], ['root', 'docking'],
  ['knots', 'capsize'], ['knots', 'whipping'], ['knots', 'cleats'], ['rig', 'cleats'], ['rig', 'trim'], ['wind', 'trim'], ['wind', 'points'],
  ['docking', 'weather'], ['capsize', 'night'], ['whipping', 'night'], ['cleats', 'overboard'], ['cleats', 'reefing'],
  ['trim', 'reefing'], ['trim', 'firstAid'], ['points', 'tides'],
  ['night', 'solo'], ['overboard', 'solo'], ['reefing', 'solo'], ['tides', 'solo'], ['firstAid', 'solo'],
];

// The whole sail tree, as the front page draws it beside the request.
export const SAIL_WIDE = {
  width: 688, height: 420, plaque: true, size: { done: 34, avail: 28, dim: 28 },
  seats: {
    root: [48, 175], knots: [190, 78], rig: [190, 142], wind: [190, 210], docking: [190, 278],
    capsize: [340, 44], whipping: [340, 103], cleats: [340, 163], trim: [340, 217], points: [340, 270], weather: [246, 338],
    night: [489, 77], overboard: [489, 142], reefing: [489, 202], tides: [489, 262], firstAid: [489, 318], solo: [638, 176],
  },
  edges: SAIL_NEEDS,
};

// Nine of its steps, small enough for a phone.
export const SAIL_NARROW = {
  width: 326, height: 200, plaque: false, size: { done: 30, avail: 26, dim: 26 },
  seats: {
    root: [34, 103], knots: [115, 47], rig: [115, 103], wind: [115, 159],
    capsize: [202, 47], cleats: [202, 103], points: [202, 159], reefing: [284, 75], tides: [284, 131],
  },
  edges: [
    ['root', 'knots'], ['root', 'rig'], ['root', 'wind'], ['knots', 'capsize'], ['knots', 'cleats'], ['rig', 'cleats'], ['wind', 'points'],
    ['cleats', 'reefing'], ['points', 'tides'],
  ],
};

// A world's seats moved by `x` and `y`, each a function of the old coordinate: one tree, laid out wider or taller.
export function stretched(world, { width, height, x = (at) => at, y = (at) => at, ...rest }) {
  const seats = Object.fromEntries(Object.entries(world.seats).map(([id, [at, down]]) => [id, [x(at), y(down)]]));
  return { ...world, width, height, seats, ...rest };
}

// The room's rule over a step book and the edges of what each step needs.
function statesOf(steps, needs) {
  return Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, step.done ? 'done'
    : needs.filter(([, to]) => to === id).every(([from]) => steps[from].done) ? 'avail' : 'dim']));
}

export function ComposedTree({ steps = SAIL, needs = SAIL_NEEDS, world, className }) {
  const { width, height, seats, edges, plaque, size } = world;
  const state = statesOf(steps, needs);
  const done = Object.values(steps).filter((step) => step.done).length;
  return (
    <div className={className ? `rmTree ${className}` : 'rmTree'} style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {edges.map(([from, to]) => {
          const [x1, y1] = seats[from];
          const [x2, y2] = seats[to];
          const bend = (x1 + x2) / 2;
          return <path key={`${from}-${to}`} className={state[from] === 'done' ? 'rmTree-edge is-lit' : 'rmTree-edge'} d={`M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`} />;
        })}
      </svg>
      {plaque && (
        <div className="plq">
          <span className="kdot" />
          <span>
            <div className="tn">{steps.root.name}</div>
            <div className="by"><b>{t('roadmap.scene.byline')}</b> · {t('roadmap.scene.progress', { done: <span className="ct">{done}</span>, total: Object.keys(steps).length })}</div>
          </span>
        </div>
      )}
      {Object.entries(seats).map(([id, [x, y]]) => {
        const { name, kind, crown } = steps[id];
        const hue = KIND_CSS[kind];
        const at = size[state[id]];
        return (
          <React.Fragment key={id}>
            {(crown ?? id === 'root') && <span className="rmTree-crown" style={{ left: x, top: y - size.done / 2 - 9 }}><Icon name="crown" size={12} strokeWidth={2.4} /></span>}
            <div className={`nd nd-${state[id]}`} style={{ left: x, top: y, width: at, height: at, '--g': hue.base, '--ring': hue.ring, '--fill': hue.base }} />
            {name && <div className={state[id] === 'dim' ? 'ndlabel ndlabel--dim' : 'ndlabel'} style={{ left: x, top: y + at / 2 + 5 }}>{name}</div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}
