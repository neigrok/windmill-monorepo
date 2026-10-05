import { resolve as resolveJsx, load } from '../../jsxLoader.mjs';
export { load };
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('/gymSync.js') && context.parentURL?.includes('/src/products/gym/')) {
    return { url: new URL('./legacyScreenApi.mjs', import.meta.url).href, shortCircuit: true };
  }
  return resolveJsx(specifier, context, next);
}
