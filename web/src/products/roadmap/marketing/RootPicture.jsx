// Roadmap's picture on the brand root: the request and the tree it became, still, on the stage the shell names.

import React from 'react';
import { Icon } from '../../../design-system';
import { KIND_CSS } from '../theme.js';
import { t } from '../i18n/entry/index.js';
import './roadmapLanding.css';
import './roadmapRootPicture.css';

const STEPS = {
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

const WIDE = {
  width: 688, height: 420, plaque: true, size: { done: 34, avail: 28, dim: 28 },
  seats: {
    root: [48, 175], knots: [190, 78], rig: [190, 142], wind: [190, 210], docking: [190, 278],
    capsize: [340, 44], whipping: [340, 103], cleats: [340, 163], trim: [340, 217], points: [340, 270], weather: [246, 338],
    night: [489, 77], overboard: [489, 142], reefing: [489, 202], tides: [489, 262], firstAid: [489, 318], solo: [638, 176],
  },
  edges: [
    ['root', 'knots'], ['root', 'rig'], ['root', 'wind'], ['root', 'docking'],
    ['knots', 'capsize'], ['knots', 'whipping'], ['knots', 'cleats'], ['rig', 'cleats'], ['rig', 'trim'], ['wind', 'trim'], ['wind', 'points'],
    ['docking', 'weather'], ['capsize', 'night'], ['whipping', 'night'], ['cleats', 'overboard'], ['cleats', 'reefing'],
    ['trim', 'reefing'], ['trim', 'firstAid'], ['points', 'tides'],
    ['night', 'solo'], ['overboard', 'solo'], ['reefing', 'solo'], ['tides', 'solo'], ['firstAid', 'solo'],
  ],
};

const NARROW = {
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

// The product's own rule over the whole tree: a step not done is open once every step it needs is done, and locked before.
const NEEDS = Object.fromEntries(Object.keys(STEPS).map((id) => [id, WIDE.edges.filter(([, to]) => to === id).map(([from]) => from)]));
const STATE = Object.fromEntries(Object.entries(STEPS).map(([id, step]) => [id,
  step.done ? 'done' : NEEDS[id].every((need) => STEPS[need].done) ? 'avail' : 'dim']));
const DONE = Object.values(STEPS).filter((step) => step.done).length;

function Tree({ world }) {
  const { width, height, seats, edges, plaque, size } = world;
  return (
    <div className="rmPicture-tree" style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {edges.map(([from, to]) => {
          const [x1, y1] = seats[from];
          const [x2, y2] = seats[to];
          const bend = (x1 + x2) / 2;
          return <path key={`${from}-${to}`} className={STATE[to] === 'dim' ? 'rmPicture-edge' : 'rmPicture-edge is-lit'} d={`M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`} />;
        })}
      </svg>
      {plaque && (
        <div className="plq in">
          <span className="kdot" />
          <span>
            <div className="tn">{STEPS.root.name}</div>
            <div className="by"><b>{t('roadmap.scene.byline')}</b> · {t('roadmap.scene.progress', { done: <span className="ct">{DONE}</span>, total: Object.keys(STEPS).length })}</div>
          </span>
        </div>
      )}
      {Object.entries(seats).map(([id, [x, y]]) => {
        const { name, kind } = STEPS[id];
        const state = STATE[id];
        const hue = KIND_CSS[kind];
        return (
          <React.Fragment key={id}>
            {id === 'root' && <span className="rmPicture-crown" style={{ left: x, top: y - size.done / 2 - 9 }}><Icon name="crown" size={12} strokeWidth={2.4} /></span>}
            <div className={`nd nd-${state}`} style={{ left: x, top: y, width: size[state], height: size[state], '--g': hue.base, '--ring': hue.ring, '--fill': hue.base }} />
            <div className={state === 'dim' ? 'ndlabel ndlabel--dim' : 'ndlabel'} style={{ left: x, top: y + size[state] / 2 + 5 }}>{name}</div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function RoadmapPicture({ stage }) {
  return (
    <div className="rmPicture" data-stage={stage}>
      <div className="rmPicture-request">
        <span className="rmPicture-label">{t('roadmap.root.request')}</span>
        <span className="rmPicture-bubble">{t('roadmap.root.requestText')}</span>
      </div>
      <span className="rmPicture-arrow"><Icon name="arrow-right" size={20} strokeWidth={1.6} /></span>
      <Tree world={stage === 'narrow' ? NARROW : WIDE} />
    </div>
  );
}
