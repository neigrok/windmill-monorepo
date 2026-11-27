// The site's header, footer and switch are drawn twice: by src/shell/marketing/site.css on the React pages and by
// scripts/staticInstrument.css on the static ones. Every rule the two share, in the same media block, keeps the same
// measures and colours, so a change to one that forgets the other fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const MEASURES = ['height', 'min-height', 'padding', 'gap', 'column-gap', 'row-gap', 'margin-top', 'margin-left', 'font-size',
  'font-weight', 'line-height', 'letter-spacing', 'color', 'background', 'border', 'border-top', 'border-bottom',
  'grid-template-columns', 'flex-direction', 'justify-content', 'align-items'];

// Each media block's rules, by selector: the declarations of every rule naming that selector, in order.
function rules(css, rename = (selector) => selector) {
  const found = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const add = (context, selectors, body) => {
    for (const selector of selectors.split(',').map((each) => rename(each.trim().replace(/\s+/g, ' ')))) {
      const declared = ((found[context] ??= {})[selector] ??= {});
      for (const declaration of body.split(';')) {
        const at = declaration.indexOf(':');
        if (at > 0) declared[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim().replace(/\s+/g, ' ');
      }
    }
  };
  let rest = text;
  for (const block of text.matchAll(/@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*\s*)\}/g)) {
    for (const rule of block[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)) add(block[1].trim(), rule[1], rule[2]);
    rest = rest.replace(block[0], '');
  }
  for (const rule of rest.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) add('all', rule[1], rule[2]);
  return found;
}

const reactName = (selector) => selector
  .replaceAll('.front-', '.site-')
  .replaceAll('.wm-segmented-segment', '.wm-appearance-segment')
  .replaceAll('.wm-segmented', '.wm-appearance');

test('the static pages draw the header, footer and switch with the React pages\' measures and colours', () => {
  const react = rules(read('../../src/shell/marketing/site.css'), reactName);
  const plain = rules(read('../../scripts/staticInstrument.css'));
  const compared = [];
  const drift = [];
  for (const [context, selectors] of Object.entries(plain)) {
    for (const [selector, declared] of Object.entries(selectors)) {
      const twin = react[context]?.[selector];
      if (!twin) continue;
      for (const property of MEASURES.filter((name) => name in declared && name in twin)) {
        compared.push(`${context} ${selector} ${property}`);
        if (declared[property] !== twin[property]) drift.push(`${context} ${selector} ${property}: static ${declared[property]}, React ${twin[property]}`);
      }
    }
  }
  assert.deepEqual(drift, []);
  for (const part of ['.site-header-row height', '.site-pill height', '.site-pill font-size', '.site-sitemap padding', '.site-sitemap-title color',
    '.site-foot padding', '.site-switch .wm-appearance-segment height', '(max-width: 743px) .site-header-row height']) {
    assert.ok(compared.some((each) => each.endsWith(part) || each === `${part.startsWith('(') ? '' : 'all '}${part}`), `${part} is not compared`);
  }
});
