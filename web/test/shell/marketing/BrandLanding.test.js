// The brand front door: what it says, where every link goes, and the one event each link and control
// tells. The page is drawn through the hook harness, its own components rendered and everything it
// borrows (the frame, the seat, the bar, a product's picture) left as the element it was handed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

// A window whose one timer the test fires, and a fetch that keeps what the beacon sends.
const sent = [];
let flush = null;
const query = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = {
  matchMedia: () => query,
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (run) => { flush = run; return 1; },
  location: { hostname: 'windmill.test', hash: '', pathname: '/' },
};
globalThis.fetch = async (url, request) => {
  sent.push(...JSON.parse(request.body).events.map(({ name, props }) => ({ name, props })));
  return { ok: true };
};
const told = () => { flush?.(); flush = null; return sent.splice(0); };

const OWN = ['SiteHeader', 'SiteFooter', 'ArrowLink', 'Brand'];

async function frontPage(t, { status, user }) {
  const { BrandLanding } = await loadScreen('shell/marketing/BrandLanding.jsx');
  const doors = [];
  const context = { status, user, signOut() { doors.push('sign-out'); }, open(request) { doors.push(request); }, lendHost() {} };
  const drawn = (tree) => elementsOf(tree).flatMap((element) => (OWN.includes(element.type?.name)
    ? drawn(renderHook(t, () => element.type(element.props), { context }).tree)
    : [element]));
  // The frame is handed its header and footer as props; the page reads header, main, footer.
  const frame = renderHook(t, () => BrandLanding(), { context }).tree;
  const elements = drawn([frame.props.header, frame.props.children, frame.props.footer]);
  return {
    doors,
    elements,
    frame,
    links: elements.filter((element) => element.type === 'a'),
    buttons: elements.filter((element) => element.type === 'button'),
    headings: elements.filter((element) => ['h1', 'h2', 'h3'].includes(element.type)),
    named: (name) => elements.find((element) => element.type?.name === name),
  };
}

const SIGNED_OUT_LINKS = [
  ['/', 'Windmill, home', { area: 'header', to: 'home' }],
  ['/roadmap', 'Roadmap', { area: 'header', to: 'landing', product: 'roadmap' }],
  ['/gym', 'Gym', { area: 'header', to: 'landing', product: 'gym' }],
  ['/journal', 'Journal', { area: 'header', to: 'landing', product: 'journal' }],
  ['/pricing.html', 'Pricing', { area: 'header', to: 'pricing' }],
  ['/app', 'Open Windmill', { area: 'header', to: 'app' }],
  ['#/app/start', 'Start a tree', { area: 'tools', to: 'room', product: 'roadmap' }],
  ['#/journal', 'Write tonight', { area: 'tools', to: 'room', product: 'journal' }],
  ['#/gym', 'Open the log', { area: 'tools', to: 'room', product: 'gym' }],
  ['#/app/start', 'Start a tree', { area: 'room', to: 'room', product: 'roadmap' }],
  ['#/journal', 'Write tonight', { area: 'room', to: 'room', product: 'journal' }],
  ['#/gym', 'Open the log', { area: 'room', to: 'room', product: 'gym' }],
  ['/connect.html', 'How to connect', { area: 'ai', to: 'connect' }],
  ['/pricing.html', 'See pricing', { area: 'ai', to: 'pricing' }],
  ['/roadmap', 'Roadmap', { area: 'sitemap', to: 'landing', product: 'roadmap' }],
  ['/gym', 'Gym', { area: 'sitemap', to: 'landing', product: 'gym' }],
  ['/journal', 'Journal', { area: 'sitemap', to: 'landing', product: 'journal' }],
  ['/connect.html', 'Connect', { area: 'sitemap', to: 'connect' }],
  ['/pricing.html', 'Pricing', { area: 'sitemap', to: 'pricing' }],
  ['/changelog.html', 'Changelog', { area: 'sitemap', to: 'changelog' }],
  ['/gallery', 'Gallery', { area: 'sitemap', to: 'gallery' }],
  ['/support.html', 'Support', { area: 'sitemap', to: 'support' }],
  ['/privacy.html', 'Privacy', { area: 'sitemap', to: 'privacy' }],
  ['/terms.html', 'Terms', { area: 'sitemap', to: 'terms' }],
  ['/refunds.html', 'Refunds', { area: 'sitemap', to: 'refunds' }],
];

test('signed out, every link goes where the contract sends it and tells one front_link', async (t) => {
  const page = await frontPage(t, { status: 'ghost', user: null });
  assert.deepEqual(told(), [{ name: 'front_open', props: { page: 'front' } }]);
  assert.deepEqual(page.links.map((link) => [link.props.href, link.props['aria-label'] ?? textOf(link)]), SIGNED_OUT_LINKS.map(([href, label]) => [href, label]));
  page.links.forEach((link) => link.props.onClick());
  assert.deepEqual(told(), SIGNED_OUT_LINKS.map(([, , props]) => ({ name: 'front_link', props: { page: 'front', ...props } })));
});

test('the page says what Windmill is under one h1, with its headings in order', async (t) => {
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  assert.deepEqual([page.frame.type.name, page.frame.props.path], ['SiteFrame', '/']);
  assert.deepEqual(page.headings.map((heading) => [heading.type, textOf(heading)]), [
    ['h1', 'Windmill is where a person keeps growing in body, skill and mind.'],
    ['h2', 'Windmill Roadmap'],
    ['h2', 'Windmill Journal'],
    ['h2', 'Windmill Gym'],
    ['h2', 'Tell an AI your goal. Get a skill tree.'],
    ['h3', 'Finish a step, the next unlocks'],
    ['h3', 'Start without an account'],
    ['h3', 'Share and fork'],
    ['h2', 'Your own words, echoed back.'],
    ['h3', 'Search by meaning'],
    ['h3', 'One page a night'],
    ['h3', 'Never graded'],
    ['h2', 'A coach that answers from your log.'],
    ['h3', 'It remembers last time'],
    ['h3', 'Honest progress'],
    ['h3', 'In your browser'],
    ['h2', 'Your AI, or ours.'],
    ['h3', 'Yours'],
    ['h3', 'Ours'],
    ['h2', 'Rooms'],
    ['h2', 'Your own assistant'],
    ['h2', 'Windmill'],
    ['h2', 'Legal'],
  ]);
  assert.deepEqual(page.elements.filter((element) => element.type === 'p').map(textOf), [
    'An AI-native workout log, skill tree and journal.',
    'The AI guides. The work stays yours. Use your own AI or ours.',
    'skill-tree planner',
    'Tell an AI your goal, get a skill tree.',
    'daily journal',
    'Your own words, echoed back.',
    'workout log',
    'A coach that answers from your log.',
    'Describe what you want to learn or build. Your own assistant, connected to your Windmill account, writes the plan as a tree of steps. You edit it, and you do the steps.',
    'Steps have real prerequisites, so the tree shows what you can work on now.',
    'Pick a ready path or paste a list. Your first tree lives in your browser.',
    'Publish a tree with one link. Anyone can copy it and make it theirs.',
    'Once you have an account and twenty written pages, passages you wrote before appear beside the page when they speak to the same thing. Nothing is interpreted and nothing is graded.',
    'Type a feeling and find the pages that mean it. The search runs in your browser, on your device.',
    'Yesterday sits a line above, and the cursor is already waiting.',
    'No streaks, no scores and no share button.',
    'Ask about your training and the answer comes from your own log, with a receipt of what it read. It proposes a change to your routine, and nothing changes until you apply it. Use Windmill’s Coach, or connect your own assistant to the same log.',
    'Each set opens with your target, or last session’s weight and reps, already filled in.',
    'Estimated one-rep max per lift over time, with no invented trend.',
    'Log a workout in any browser, with no account. The phone apps are in beta and not public yet.',
    'Either way the AI guides, and the work stays yours.',
    'Connect the assistant you already have to Roadmap and Gym. It asks for the access it needs, and you approve it.',
    'Windmill’s own AI is built in, and a free account includes some of it each month. Windmill One raises the ceiling for one price. It is not on sale yet.',
    'Web: Roadmap, Gym and Journal. The phone apps are in beta and not public yet.',
  ]);
});

test('no line on the page promises what the product does not do, names a price or links an About page', async (t) => {
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  const words = page.elements.filter((element) => typeof element.type === 'string').map(textOf).join('  ');
  for (const refused of ['works for you', 'working for you', 'does it for you', 'About', 'or Windmill’s, writes', 'As you write', 'has read every set', 'your whole log', 'the same rules', 'two taps', 'Android today', 'free allowance', 'training log', 'direct download', 'Android: Gym']) {
    assert.equal(words.includes(refused), false, refused);
  }
  assert.doesNotMatch(words, /[$€£]\s?\d|\d+\s?(USD|dollars)/);
});

test('each room hands the frame its picture, labelled as composed, under the name its event tells, with the stages it is drawn at', async (t) => {
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  const frames = page.elements.filter((element) => element.type?.name === 'PictureFrame');
  assert.deepEqual(frames.map(({ props }) => [props.id, props.page, props.route, props.picture.name, props.picture.label, props.theme, props.picture.stages.map((stage) => stage.name)]), [
    ['roadmap', 'front', '/', 'root', 'Composed tree', 'light', ['narrow', 'column', 'row']],
    ['journal', 'front', '/', 'root', 'Composed page', 'light', ['narrow', 'column', 'wide']],
    ['gym', 'front', '/', 'root', 'Composed session', 'light', ['narrow', 'wide']],
  ]);
});

test('while auth is unanswered a stranger already sees Sign in and the pill, and the page has told its opening', async (t) => {
  const page = await frontPage(t, { status: 'loading', user: null });
  assert.deepEqual(told(), [{ name: 'front_open', props: { page: 'front' } }]);
  assert.deepEqual(page.buttons.map(textOf), ['Sign in', 'Feedback']);
  assert.equal(page.named('AccountSeat'), undefined);
  assert.equal(page.links.find((link) => textOf(link) === 'Open Windmill').props.href, '/app');
  assert.equal(page.elements.some((element) => element.props?.style?.visibility === 'hidden'), false);
});

test('a link already sent is a reminder that reopens the door on its wait, and tells link_sent', async (t) => {
  const record = JSON.stringify({ email: 'ada@example.com', at: Date.now() });
  globalThis.sessionStorage = { getItem: (key) => (key === 'windmill:link-sent' ? record : null), setItem() {}, removeItem() {} };
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  assert.deepEqual(page.buttons.map(textOf), ['Link sent — check your emailLink sent', 'Feedback']);
  page.buttons[0].props.onClick();
  assert.equal(page.doors[0].resume.email, 'ada@example.com');
  assert.deepEqual(told(), [{ name: 'front_control', props: { page: 'front', control: 'link_sent' } }]);
  delete globalThis.sessionStorage;
});

test('signed out, Sign in opens the door in place, and each control tells one front_control', async (t) => {
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  assert.deepEqual(page.buttons.map(textOf), ['Sign in', 'Feedback']);
  assert.equal(page.named('AccountSeat'), undefined);

  page.buttons[0].props.onClick();
  assert.equal(page.doors.length, 1);
  page.buttons[1].props.onClick();
  assert.deepEqual(told(), [
    { name: 'front_control', props: { page: 'front', control: 'sign_in' } },
    { name: 'front_control', props: { page: 'front', control: 'feedback' } },
  ]);
});

test('the switch offers Auto, Light and Dark, starts on Auto and stores what is picked', async (t) => {
  const disk = new Map();
  globalThis.localStorage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: (key) => disk.delete(key) };
  const { setAppearance } = await loadScreen('shell/appearance.js');
  setAppearance('system');
  disk.clear();
  const page = await frontPage(t, { status: 'ghost', user: null });
  told();
  const bar = page.named('SegmentedControl');
  assert.deepEqual(bar.props.options.map((option) => [option.value, option.label, option.icon]), [['system', 'Auto', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']]);
  assert.equal(bar.props.value, 'system');

  bar.props.onChange('system');
  assert.equal(disk.has('windmill:appearance'), false, 'the segment already in use stores nothing');
  assert.deepEqual(told(), [], 'the segment already in use tells nothing');
  bar.props.onChange('dark');
  assert.equal(disk.get('windmill:appearance'), 'dark');
  assert.deepEqual(told(), [{ name: 'front_control', props: { page: 'front', control: 'appearance', choice: 'dark' } }]);
  delete globalThis.localStorage;
});

test('signed in, the seat stands where Sign in stood and the pill opens the last room', async (t) => {
  const { homeHash } = await loadScreen('shell/products.js');
  const user = { name: 'Ada', email: 'ada@example.com' };
  const page = await frontPage(t, { status: 'signed-in', user });
  assert.deepEqual(told(), [{ name: 'front_open', props: { page: 'front' } }]);
  assert.deepEqual(page.buttons.map(textOf), ['Feedback']);
  const seat = page.named('AccountSeat');
  assert.deepEqual([seat.props.user, seat.props.size, seat.props.display, seat.props.appearance], [user, 28, 'glyph', false]);
  const signedInLinks = SIGNED_OUT_LINKS.map(([href, label]) => [label === 'Open Windmill' ? homeHash() : href, label]);
  assert.deepEqual(page.links.map((link) => [link.props.href, link.props['aria-label'] ?? textOf(link)]), signedInLinks);
  page.links.forEach((link) => link.props.onClick());
  assert.deepEqual(told(), SIGNED_OUT_LINKS.map(([, , props]) => ({ name: 'front_link', props: { page: 'front', ...props } })));

  seat.props.onSettings();
  assert.equal(window.location.hash, '#/settings');
  seat.props.onSignOut();
  assert.deepEqual(page.doors, ['sign-out']);
  assert.deepEqual(told(), [{ name: 'front_control', props: { page: 'front', control: 'settings' } }, { name: 'front_control', props: { page: 'front', control: 'sign_out' } }]);
  window.location.hash = '';
});
