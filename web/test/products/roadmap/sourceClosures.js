import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';

// A hook's event boundaries read many live handles, so these tests lift the closure itself out of the source and run it with
// the collaborators they inject: the real code, with no React and no WebGL.
export async function closuresIn(relativeToRoadmap) {
  const path = new URL(`../../../src/products/roadmap/${relativeToRoadmap}`, import.meta.url);
  const { code } = await transformWithEsbuild(await readFile(path, 'utf8'), relativeToRoadmap, { loader: 'jsx' });
  const found = { callbacks: new Map(), properties: new Map(), effects: [] };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const callback = node.init?.arguments?.[0];
    if (node.type === 'VariableDeclarator' && callback) found.callbacks.set(node.id.name, code.slice(callback.start, callback.end));
    if (node.type === 'Property' && node.key.name && node.value.type === 'ArrowFunctionExpression') found.properties.set(node.key.name, code.slice(node.value.start, node.value.end));
    if (node.type === 'CallExpression' && node.callee.name === 'useEffect') found.effects.push(code.slice(node.arguments[0].start, node.arguments[0].end));
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  const bound = (source, scope) => {
    if (!source) throw new Error(`No such closure in ${relativeToRoadmap}`);
    return runInNewContext(`(${source})`, scope);
  };
  return {
    callback: (name, scope) => bound(found.callbacks.get(name), scope),
    property: (name, scope) => bound(found.properties.get(name), scope),
    effectWith: (text, scope) => bound(found.effects.find((effect) => effect.includes(text)), scope),
  };
}
