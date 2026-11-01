import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: BoardView } = await import('../../../../src/products/roadmap/board/BoardView.jsx');
const { boardFrame } = await import('../../../../src/products/roadmap/board/BoardStates.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');

const sail = (nodes) => new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
const twoSteps = [
  { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
  { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky' },
];

// The markup with inline styles dropped and each icon reduced to its tag, so a frame reads as structure and words.
function frame(props) {
  const html = renderToStaticMarkup(React.createElement(BoardView, {
    tree: null,
    completed: new Set(),
    completedAt: {},
    selectedId: null,
    onSelect: () => {},
    onSwitchView: () => {},
    breakpoint: 'desktop',
    ...props,
  }));
  return html
    .replace(/ style="[^"]*"/g, '')
    .replace(/<svg[^>]*>.*?<\/svg>/g, '<svg/>')
    .replace(/^<div class="st-board [^"]+">/, '')
    .replace(/<\/div>$/, '');
}

test('boardFrame — a failure, then a roadmap still loading, then one with no steps, then the columns', () => {
  assert.deepEqual([
    boardFrame({ tree: null, loading: true }),
    boardFrame({ tree: null, failed: true }),
    boardFrame({ tree: sail(twoSteps), loading: false, failed: true }),
    boardFrame({ tree: sail(twoSteps), loading: true }),
    boardFrame({ tree: null }),
    boardFrame({ tree: sail([]) }),
    boardFrame({ tree: sail(twoSteps) }),
  ], ['loading', 'error', 'error', 'loading', 'loading', 'empty', 'columns']);
});

test('BoardStates — from 744px the skeleton holds the three columns with their titles, no counts and no spinner', () => {
  const card = '<span class="st-board-skeleton-card st-board-skeleton-card--columns" aria-hidden="true"><span class="st-board-skeleton-rail"></span>'
    + '<span class="st-board-skeleton-lines"><span class="st-board-skeleton-line"></span><span class="st-board-skeleton-line"></span></span></span>';
  assert.equal(frame({ loading: true }), [
    '<div class="st-board-columns" aria-busy="true">',
    '<section class="st-board-columns-column st-board-columns-column--locked"><h2 class="st-board-columns-heading st-board-columns-heading--locked">',
    `<span class="st-board-columns-title">Locked</span></h2>${card}${card}${card}</section>`,
    '<section class="st-board-columns-column st-board-columns-column--upNext"><h2 class="st-board-columns-heading st-board-columns-heading--upNext">',
    `<span class="st-board-columns-accent" aria-hidden="true"></span><span class="st-board-columns-title">Up next</span></h2>${card}${card}</section>`,
    '<section class="st-board-columns-column st-board-columns-column--done"><h2 class="st-board-columns-heading st-board-columns-heading--done">',
    `<span class="st-board-columns-title">Done</span></h2>${card}${card}${card}</section>`,
    '</div>',
  ].join(''));
});

test('BoardStates — the phone skeleton holds Up next over the band, whose tabs show no counts and take no press', () => {
  const card = (size) => `<span class="st-board-skeleton-card st-board-skeleton-card--${size}" aria-hidden="true"><span class="st-board-skeleton-rail"></span>`
    + `<span class="st-board-skeleton-lines"><span class="st-board-skeleton-line"></span><span class="st-board-skeleton-line"></span>${size === 'reason' ? '<span class="st-board-skeleton-line"></span>' : ''}</span></span>`;
  const tab = (title, selected) => `<span class="st-board-phone-segment" aria-selected="${selected}"><span class="st-board-phone-segment-surface"><span class="st-board-phone-segment-label">${title}</span></span></span>`;
  assert.equal(frame({ loading: true, breakpoint: 'phone', identity: true, title: 'Learn to sail' }), [
    '<header class="st-board-identity"><h1 class="st-board-identity-title" title="Learn to sail">Learn to sail</h1>',
    '<div class="st-board-switch st-board-switch--phone" role="group" aria-label="View">',
    '<button type="button" class="st-board-switch-option" aria-label="Board" aria-pressed="true"><svg/></button>',
    '<button type="button" class="st-board-switch-option" aria-label="Graph" aria-pressed="false"><svg/></button></div></header>',
    '<div class="st-board-phone" aria-busy="true"><div class="st-board-phone-panes"><div class="st-board-phone-pane is-shown">',
    `<h2 class="st-board-phone-heading">Up next</h2>${card('reason')}${card('plain')}${card('reason')}</div></div>`,
    `<div class="st-board-phone-band st-board-quiet-band" aria-hidden="true"><div class="st-board-phone-segments">${tab('Locked', false)}${tab('Up next', true)}${tab('Done', false)}</div></div>`,
    '</div>',
  ].join(''));
});

test('BoardStates — a load error says so in the frame and offers Try again; on the phone it is pinned over the band', () => {
  assert.equal(frame({ failed: true, onRetry: () => {} }).replace(/<button type="button"[^>]*>/, '<button>'), [
    '<div class="st-board-state" role="alert"><div class="st-board-state-message"><svg/>',
    '<h2 class="st-board-state-title">Couldn’t load this roadmap</h2>',
    '<p class="st-board-state-body">It may have moved, or the server is unreachable.</p>',
    '<button>Try again</button></div></div>',
  ].join(''));
  const phone = frame({ failed: true, onRetry: () => {}, breakpoint: 'phone' });
  assert.match(phone, /^<div class="st-board-state st-board-state--phone" role="alert"><div class="st-board-state-message"><svg\/><h2 class="st-board-state-title">Couldn’t load this roadmap<\/h2>/);
  assert.match(phone, /<div class="st-board-state-pinned"><button type="button"[^>]*>Try again<\/button><\/div><\/div><div class="st-board-phone-band st-board-quiet-band" aria-hidden="true">/);
});

test('BoardStates — an empty roadmap pins New step as its one primary, with no progress', () => {
  assert.equal(frame({ tree: sail([]), onNewStep: () => {}, identity: true, title: 'Learn to sail' }).replace(/<div class="st-board-switch[^]*?<\/div>/, '<switch/>'), [
    '<header class="st-board-identity"><h1 class="st-board-identity-title" title="Learn to sail">Learn to sail</h1><switch/></header>',
    '<div class="st-board-state st-board-state--empty"><div class="st-board-state-message st-board-state-message--empty">',
    '<h2 class="st-board-state-title">Your first step</h2><p class="st-board-state-body">Give your roadmap a place to start.</p></div>',
    '<button type="button" class="st-board-new-step"><svg/>New step</button></div>',
  ].join(''));
});

test('BoardStates — with every step done, Up next rests on Roadmap complete: Share it and New step for the owner, the count alone for a reader', () => {
  const upNext = (props) => /st-board-columns-column--upNext"[^>]*>.*?<\/h2>(.*?)<\/section>/.exec(frame({ tree: sail(twoSteps), completed: new Set(['course', 'parts']), ...props }))[1]
    .replace(/<button type="button"(?! class)[^>]*>/g, '<button>');
  assert.equal(upNext({ onShare: () => {}, onNewStep: () => {} }), [
    '<div class="st-board-complete"><h3 class="st-board-complete-title">All 2 steps done</h3>',
    '<p class="st-board-state-body">Add a step whenever you’re ready.</p>',
    '<div class="st-board-complete-actions"><button>Share it</button><button type="button" class="st-board-new-step"><svg/>New step</button></div></div>',
  ].join(''));
  assert.equal(upNext({}), '<div class="st-board-complete"><h3 class="st-board-complete-title">All 2 steps done</h3></div>');
  assert.equal(frame({ tree: sail(twoSteps), completed: new Set(['course']), onShare: () => {} }).includes('st-board-complete'), false);
});

test('BoardStates — on the phone Roadmap complete stands under the crown in the Up next pane, with Share it and no New step', () => {
  const pane = /aria-labelledby="[^"]*tab-upNext" class="st-board-phone-pane is-shown[^"]*"[^>]*>(.*?)<\/div><div id/.exec(
    frame({ tree: sail(twoSteps), completed: new Set(['course', 'parts']), breakpoint: 'phone', onShare: () => {}, onNewStep: () => {} }),
  )[1].replace(/<button type="button"[^>]*>/g, '<button>');
  assert.equal(pane, [
    '<h2 class="st-board-phone-heading">Up next</h2>',
    '<div class="st-board-complete st-board-complete--phone"><svg/><h3 class="st-board-complete-title">All 2 steps done</h3>',
    '<p class="st-board-state-body">Add a step whenever you’re ready.</p>',
    '<div class="st-board-complete-actions"><button>Share it</button></div></div>',
  ].join(''));
});
