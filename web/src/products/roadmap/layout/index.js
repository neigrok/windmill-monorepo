// The one door to a layout engine: `?layout=<name>` before or after the hash picks one, the default is here and the rest
// behind a dynamic import, and an engine that fails to load or throws is answered by radial rather than a blank canvas.

import RadialLayoutEngine from './RadialLayoutEngine.js';

export const LAYOUTS = ['radial', 'rings', 'bubble', 'mindmap'];
export const DEFAULT_LAYOUT = 'radial';

const ENGINE_MODULES = {
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

// The engine every surface that draws a tree outside the canvas — a quest thumbnail, a paste ghost — lays out with.
export function defaultLayoutEngine() {
  return new RadialLayoutEngine();
}

export async function loadLayoutEngine(name) {
  if (!LAYOUTS.includes(name)) throw new Error(`Unknown layout "${name}"`);
  if (name === DEFAULT_LAYOUT) return defaultLayoutEngine();
  try {
    const module = await ENGINE_MODULES[name]();
    return new module.default();
  } catch (error) {
    console.error(`[layout] the ${name} engine failed to load — drawing the tree radially instead`, error);
    return defaultLayoutEngine();
  }
}

export function layoutTree(engine, tree) {
  try {
    return engine.layout(tree);
  } catch (error) {
    console.error(`[layout] ${engine.constructor.name} could not lay out ${tree.allNodes.length} steps — drawing the tree radially instead`, error);
    return defaultLayoutEngine().layout(tree);
  }
}
