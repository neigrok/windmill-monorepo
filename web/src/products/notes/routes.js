// The notes product's route table — one route (#/notes) for now. Same contract the roadmap
// exports, so the shell composes all three products through one uniform loop.

import { lazy } from 'react';

const NotesApp = lazy(() => import('./NotesApp.jsx').then((m) => ({ default: m.NotesApp })));

function home() { return '#/notes'; }

function render({ hash }) {
  if (hash.startsWith('#/notes')) return { Component: NotesApp, props: {} };
  return null;
}

export const notesRoutes = {
  id: 'notes',
  label: 'Notes',
  switchHash: '#/notes',
  home,
  render,
};
