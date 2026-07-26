// The gym product's route table — one route (#/gym) for now. Same contract the roadmap and
// notes export, so the shell composes all three through one uniform loop.

import { lazy } from 'react';

const GymApp = lazy(() => import('./GymApp.jsx').then((m) => ({ default: m.GymApp })));

function home() { return '#/gym'; }

function render({ hash }) {
  if (hash.startsWith('#/gym')) return { Component: GymApp, props: {} };
  return null;
}

export const gymRoutes = {
  id: 'gym',
  label: 'Gym',
  switchHash: '#/gym',
  home,
  render,
};
