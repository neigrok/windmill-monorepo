// The one door to a layout engine. Each engine lives in its own module behind a dynamic import, so an engine that fails
// to load or lay out can never take the others down with it; `?layout=<name>` before or after the hash picks one.

export const LAYOUTS = ['radial', 'rings', 'bubble', 'mindmap'];
export const DEFAULT_LAYOUT = 'radial';

const ENGINE_MODULES = {
  radial: () => import('./RadialLayoutEngine.js'),
  rings: () => import('./RingsLayoutEngine.js'),
  bubble: () => import('./BubbleLayoutEngine.js'),
  mindmap: () => import('./MindmapLayoutEngine.js'),
};

// `/?layout=bubble#/app/<id>` and `/#/app/<id>?layout=bubble` both name the engine; anything else is the default.
export function layoutNameFrom({ search = '', hash = '' }) {
  const afterHash = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  const named = new URLSearchParams(afterHash).get('layout') ?? new URLSearchParams(search).get('layout');
  return LAYOUTS.includes(named) ? named : DEFAULT_LAYOUT;
}

export async function loadLayoutEngine(name) {
  if (!LAYOUTS.includes(name)) throw new Error(`Unknown layout "${name}"`);
  const module = await ENGINE_MODULES[name]();
  return new module.default();
}
