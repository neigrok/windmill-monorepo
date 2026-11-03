import { existsSync } from 'node:fs';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('/activity/ActivityRows.jsx') && !existsSync(new URL(specifier, context.parentURL))) {
    return { url: new URL('./ActivityRows.fixture.jsx', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
