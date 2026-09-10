// Bubble is the normal layout; explicit URL alternatives use the same entry point as every preview.
import BubbleLayoutEngine from './BubbleLayoutEngine.js';
import RadialLayoutEngine from './RadialLayoutEngine.js';

export const LAYOUTS = ['radial', 'rings', 'bubble', 'mindmap'];
export const DEFAULT_LAYOUT = 'bubble';
export const FALLBACK_LAYOUT = 'radial';

const ENGINE_MODULES = {
  rings: () => import('./RingsLayoutEngine.js'),
  mindmap: () => import('./MindmapLayoutEngine.js'),
};

// `/?layout=radial#/app/<id>` and `/#/app/<id>?layout=radial` both name the engine; anything else is the default.
export function layoutNameFrom({ search = '', hash = '' }) {
  const afterHash = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
  const named = new URLSearchParams(afterHash).get('layout') ?? new URLSearchParams(search).get('layout');
  return LAYOUTS.includes(named) ? named : DEFAULT_LAYOUT;
}

// The fallback is synchronous so a layout failure can be handled in the same render pass.
export function fallbackLayoutEngine() {
  return new RadialLayoutEngine();
}

export async function loadLayoutEngine(name) {
  if (!LAYOUTS.includes(name)) throw new Error(`Unknown layout "${name}"`);
  if (name === DEFAULT_LAYOUT) return new BubbleLayoutEngine();
  if (name === FALLBACK_LAYOUT) return fallbackLayoutEngine();
  try {
    const module = await ENGINE_MODULES[name]();
    return new module.default();
  } catch (error) {
    console.error(`[layout] the ${name} engine failed to load — drawing the tree radially instead`, error);
    return fallbackLayoutEngine();
  }
}

// Each consumer gets its own stateless engine; imported alternative modules are cached by the browser.
export function pageLayoutEngine() {
  return loadLayoutEngine(layoutNameFrom(window.location));
}

export function layoutTree(engine, tree) {
  try {
    return { positions: engine.layout(tree), name: engine.constructor.layoutName, engine };
  } catch (error) {
    console.error(`[layout] ${engine.constructor.name} could not lay out ${tree.allNodes.length} steps — drawing the tree radially instead`, error);
    const fallback = fallbackLayoutEngine();
    return { positions: fallback.layout(tree), name: FALLBACK_LAYOUT, engine: fallback };
  }
}
