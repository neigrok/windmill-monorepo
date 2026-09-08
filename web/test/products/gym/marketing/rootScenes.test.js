import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the scenes on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { GymGlimpse, GymIllustration } = await import('../../../../src/products/gym/marketing/RootScenes.jsx');
const { TURN_DOWN_VERB } = await import('../../../../src/products/gym/proposals.js');

const ROOT_CSS = readFileSync(new URL('../../../../src/products/gym/marketing/gymRootScenes.css', import.meta.url), 'utf8');
const LANDING_CSS = readFileSync(new URL('../../../../src/products/gym/marketing/gymLanding.css', import.meta.url), 'utf8');
const ISLANDS = readFileSync(new URL('../../../../src/products/gym/marketing/gymIslands.css', import.meta.url), 'utf8');
const SCENES = readFileSync(new URL('../../../../src/products/gym/marketing/RootScenes.jsx', import.meta.url), 'utf8');
const TOKENS = readFileSync(new URL('../../../../src/products/gym/gymTokens.css', import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the glimpse is the Squat set-logger card, captioned as composed, with the stepper and the log', () => {
  const html = renderToStaticMarkup(React.createElement(GymGlimpse));
  assert.equal(text(html), 'Squat set 3 of 5 100 kg × 5 -10 -2.5 +2.5 +10 Last time · 97.5 kg × 5 Log set Composed session');
  assert.match(html, /<figcaption class="composed">Composed session<\/figcaption>/);
  assert.equal((html.match(/class="gychip"/g) ?? []).length, 4);
  assert.match(html, /<span class="gyRoot-button">Log set<\/span>/, 'the log is a styled span, not a control');
});

test('the illustration is the phone logger beside the proposal, verbatim', () => {
  const html = renderToStaticMarkup(React.createElement(GymIllustration));
  assert.equal(text(html), 'Squat set 3 of 5 100 kg × 5 Last time · 97.5 kg × 5 -10 -2.5 +2.5 +10 Log set set 1 100 × 5 set 2 100 × 5 Proposed by your AI tool Squat · next session - 100 kg × 5 × 5 + 102.5 kg × 5 × 5 Three sessions at 100 × 5 with reps to spare. Apply Turn this down Composed session');
  assert.match(html, /<span class="gyRoot-diff-add">\+ 102\.5 kg × 5 × 5<\/span>/, 'the + line wears the brand');
  assert.equal((html.match(/class="gyck"/g) ?? []).length, 2, 'both logged sets carry the check');
});

// `Composed session` licenses a session assembled from real material, never an affordance gym does
// not have. The scene draws the shipped review's pair: Apply as the band, and the room's own verb as
// the plain row beneath it — no second button, and nothing called `Not now`.
test('the proposal draws the shipped verb and the shipped weighting, not a pair of equals', () => {
  const html = renderToStaticMarkup(React.createElement(GymIllustration));
  assert.equal(TURN_DOWN_VERB, 'Turn this down');
  assert.match(html, new RegExp(`<div class="gyRoot-acts"><span class="gyRoot-button">Apply</span><span class="gyRoot-turn-down">${TURN_DOWN_VERB}</span></div>`));
  assert.ok(!/Not now|--ghost/.test(html), 'the scene invents a control gym does not ship');
  assert.ok(!/--ghost/.test(ROOT_CSS) && !/--ghost/.test(LANDING_CSS), 'the ghost button outlives the scene that drew it');
  const acts = ROOT_CSS.slice(ROOT_CSS.indexOf('.gyRoot-acts {')).split('}')[0];
  assert.match(acts, /flex-direction: column; align-items: stretch;/, 'Apply is not the band across the card');
  const turnDown = ROOT_CSS.slice(ROOT_CSS.indexOf('.gyRoot-turn-down {')).split('}')[0];
  assert.match(turnDown, /color: var\(--gym-ink-dim\);/, 'the decline is not de-emphasised');
  assert.ok(!/background|border/.test(turnDown), 'the decline is drawn as a button, not a plain text row');
});

// The composed session is decoration; the caption is the only thing a reader is told about it. An
// aria-hidden on the figure would swallow the caption with it, which is the whole defect.
test('each scene hides one stage and announces the caption outside it', () => {
  for (const [Scene, stage] of [[GymGlimpse, 'gyw gym-skin gyRoot'], [GymIllustration, 'gyRoot-pair']]) {
    const html = renderToStaticMarkup(React.createElement(Scene));
    assert.match(html, new RegExp(`^<figure class="gyRoot-scene"><div class="${stage}" aria-hidden="true">`), `${Scene.name} does not open with its figure and one hidden stage`);
    assert.match(html, /<\/div><figcaption class="composed">Composed session<\/figcaption><\/figure>$/, `${Scene.name} does not close with the caption outside the stage`);
    assert.ok(!/<(figure|figcaption)[^>]*aria-hidden/.test(html), `${Scene.name} hides the figure or the caption with the stage`);
  }
});

test('both scenes are still, fluid, free of raw colour, and wear the skin the tokens are keyed on', () => {
  for (const Scene of [GymGlimpse, GymIllustration]) {
    const html = renderToStaticMarkup(React.createElement(Scene));
    assert.ok(!/animation|style=/.test(html), `${Scene.name} carries motion or an inline style`);
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(html), `${Scene.name} names a raw colour`);
    assert.ok(!/data-theme/.test(html), `${Scene.name} stamps a theme of its own instead of taking the ground’s`);
    assert.match(html, /class="gyw gym-skin gyRoot/);
  }
  assert.ok(!/animation|#[0-9a-fA-F]{3,6}\b/.test(ROOT_CSS), 'the root sheet animates or names a raw colour');
  assert.match(ROOT_CSS, /\.gyRoot \{\n  width: 100%;\n  min-width: 0;/);
  assert.match(ROOT_CSS, /\.gyRoot-pair \{[^}]*width: 100%; min-width: 0;/);
  for (const theme of ['dark', 'light']) {
    assert.match(TOKENS, new RegExp(`\\[data-theme="${theme}"\\]\\[data-brand="gym"\\] \\.gym-skin:not\\(\\[data-theme\\]\\)`), `${theme}: an unstamped skin takes the ground’s tokens`);
  }
});

// The root draws six static cards; it may not pull the landing's hero moat, loop stages and movement
// shelf to do it. The parts both sheets build islands from keep one home, gymIslands.css.
test('the scenes carry their own sheet, and the island parts have a single home', () => {
  assert.match(SCENES, /^import '\.\/gymRootScenes\.css';$/m);
  assert.ok(!/gymLanding\.css/.test(SCENES), 'the scenes still pull the full landing sheet');
  assert.ok(!/\.gyRoot/.test(LANDING_CSS), 'a root-scene rule is still in the landing sheet');
  assert.ok(!/\.gyMoat|\.gyStage|\.gycard|\.gyrep|\.gyInnerCard|@keyframes/.test(ROOT_CSS), 'a landing-only rule leaked into the root sheet');
  for (const sheet of [ROOT_CSS, LANDING_CSS]) {
    assert.match(sheet, /^@import '\.\.\/gymTokens\.css';\n@import '\.\/gymIslands\.css';/);
  }
  for (const part of ['gyCaption', 'gyWell', 'gychip', 'gyset', 'gyck']) {
    const own = new RegExp(`^\\.${part} \\{`, 'm');
    assert.match(ISLANDS, own, `.${part} is not in the shared parts sheet`);
    assert.ok(!own.test(LANDING_CSS) && !own.test(ROOT_CSS), `.${part} is drawn twice`);
  }
});
