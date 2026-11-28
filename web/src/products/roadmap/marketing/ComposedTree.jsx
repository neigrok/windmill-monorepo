// A tree for the site's pictures, drawn in the room's node vocabulary and by the room's rule: a step not done is
// available once every step it needs is done and locked before, and every edge out of a done step is lit. A world
// places the steps it shows; the steps and what each needs come from the step book it is drawn with. It rests still and
// answers the pointer with the room's own motion (composedTree.css).

import React from 'react';
import { Icon } from '../../../design-system';
import { KIND_CSS } from '../theme.js';
import { HANDOFF, IGNITE } from '../ceremony/beats.js';
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

// A branch leaves its step level, bends halfway across and enters the next step level.
function branchPath([x1, y1], [x2, y2]) {
  const bend = (x1 + x2) / 2;
  return `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`;
}

// How far a branch runs, summed over 64 straight pieces of its curve.
function branchLength([x1, y1], [x2, y2]) {
  const bend = (x1 + x2) / 2;
  const at = (t) => {
    const u = 1 - t;
    return [u * u * u * x1 + 3 * u * u * t * bend + 3 * u * t * t * bend + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2];
  };
  const points = Array.from({ length: 65 }, (_, piece) => at(piece / 64));
  return points.slice(1).reduce((sum, [x, y], index) => sum + Math.hypot(x - points[index][0], y - points[index][1]), 0);
}

// The room's unlock (motion language §2, ceremony #4) on a world whose finished steps open others. Each finished step
// blossoms at once; when its ignite ends a head travels every lit branch into an open step, at 540px a second within
// 180–420ms; the open step wakes at 85% of the way, and when the last wake settles every opened step pulses.
const WAKE_MS = 480;
const travelMs = (length) => Math.round(Math.min(420, Math.max(180, (length / 540) * 1000)));

function unlockOf(world, state) {
  const travels = world.edges.filter(([from, to]) => state[from] === 'done' && state[to] === 'avail').map(([from, to]) => {
    const length = Math.round(branchLength(world.seats[from], world.seats[to]) * 10) / 10;
    return { from, to, length, duration: travelMs(length) };
  });
  const wakeAt = {};
  for (const { to, duration } of travels) wakeAt[to] = Math.min(wakeAt[to] ?? Infinity, Math.round(IGNITE + HANDOFF * duration));
  const pulseAt = Math.max(...Object.values(wakeAt)) + WAKE_MS;
  const opened = Object.fromEntries(Object.entries(wakeAt).map(([id, at]) => [id, { '--wake-at': `${at}ms`, '--pulse-at': `${pulseAt}ms` }]));
  return { travels, opened };
}

// `arrival` names the beat the tree plays when the pointer arrives on its picture: `frontier`, its open steps pulsing,
// `unlock`, the room's unlock, or null, none.
export function ComposedTree({ steps = SAIL, needs = SAIL_NEEDS, world, arrival = 'frontier', className }) {
  const { width, height, seats, edges, plaque, size } = world;
  const state = statesOf(steps, needs);
  const done = Object.values(steps).filter((step) => step.done).length;
  const unlock = arrival === 'unlock' ? unlockOf(world, state) : null;
  return (
    <div className={className ? `rmTree ${className}` : 'rmTree'} data-arrival={arrival ?? undefined} style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {edges.map(([from, to]) => (
          <g key={`${from}-${to}`} className="rmTree-branch">
            <path className="rmTree-reach" d={branchPath(seats[from], seats[to])} />
            <path className={state[from] === 'done' ? 'rmTree-edge is-lit' : 'rmTree-edge'} d={branchPath(seats[from], seats[to])} />
          </g>
        ))}
        {unlock?.travels.map(({ from, to, length, duration }) => (
          <g key={`${from}-${to}`} className="rmTree-travel" style={{ '--length': `${length}px`, '--travel-at': `${IGNITE}ms`, '--travel': `${duration}ms` }}>
            <path className="rmTree-tail" d={branchPath(seats[from], seats[to])} />
            <path className="rmTree-head" d={branchPath(seats[from], seats[to])} />
          </g>
        ))}
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
        const crowned = crown ?? id === 'root';
        const opened = unlock?.opened[id];
        const hue = KIND_CSS[kind];
        const at = size[state[id]];
        return (
          <React.Fragment key={id}>
            {crowned && <span className="rmTree-crown" style={{ left: x, top: y - size.done / 2 - 9 }}><Icon name="crown" size={12} strokeWidth={2.4} /></span>}
            <div className={`nd nd-${state[id]}${crowned ? ' is-crowned' : ''}${opened ? ' is-opened' : ''}`}
              style={{ left: x, top: y, width: at, height: at, '--g': hue.base, '--ring': hue.ring, '--fill': hue.base, ...opened }} />
            {name && <div className={state[id] === 'dim' ? 'ndlabel ndlabel--dim' : 'ndlabel'} style={{ left: x, top: y + at / 2 + 5 }}>{name}</div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}
