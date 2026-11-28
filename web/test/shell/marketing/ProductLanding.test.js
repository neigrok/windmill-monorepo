// Each product's landing: what it says, in what order, where every link goes, and the one event each link and control
// tells. The page is drawn through the hook harness from the page its product supplies, its own components rendered
// and everything it borrows (the frame, the seat, the bar, a product's picture) left as the element it was handed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

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

const OWN = ['SiteHeader', 'SiteFooter', 'ArrowLink', 'Brand', 'Features', 'Tail', 'Section', 'Pair', 'LeadLink'];

async function landing(t, id, { status = 'ghost', user = null } = {}) {
  const { ProductLanding } = await loadScreen('shell/marketing/ProductLanding.jsx');
  const { PRODUCTS } = await loadScreen('shell/products.js');
  const product = PRODUCTS.find((each) => each.id === id);
  const page = await product.landing.page();
  const context = { status, user, signOut() {}, open() {}, lendHost() {} };
  const drawn = (tree) => elementsOf(tree).flatMap((element) => (OWN.includes(element.type?.name)
    ? drawn(renderHook(t, () => element.type(element.props), { context }).tree)
    : [element]));
  const frame = renderHook(t, () => ProductLanding({ product, page }), { context }).tree;
  const elements = drawn([frame.props.header, frame.props.children, frame.props.footer]);
  const main = drawn(frame.props.children);
  return {
    page,
    frame,
    main,
    links: elements.filter((element) => element.type === 'a'),
    buttons: elements.filter((element) => element.type === 'button'),
    headings: main.filter((element) => ['h1', 'h2', 'h3'].includes(element.type)),
    frames: main.filter((element) => element.type?.name === 'PictureFrame'),
  };
}

const CHROME_BEFORE = (page) => [
  ['/', 'Windmill, home', { page, area: 'header', to: 'home' }],
  ['/roadmap', 'Roadmap', { page, area: 'header', to: 'landing', product: 'roadmap' }],
  ['/gym', 'Gym', { page, area: 'header', to: 'landing', product: 'gym' }],
  ['/journal', 'Journal', { page, area: 'header', to: 'landing', product: 'journal' }],
  ['/pricing.html', 'Pricing', { page, area: 'header', to: 'pricing' }],
  ['/app', 'Open Windmill', { page, area: 'header', to: 'app' }],
];
const CHROME_AFTER = (page) => [
  ['/roadmap', 'Roadmap', { page, area: 'sitemap', to: 'landing', product: 'roadmap' }],
  ['/gym', 'Gym', { page, area: 'sitemap', to: 'landing', product: 'gym' }],
  ['/journal', 'Journal', { page, area: 'sitemap', to: 'landing', product: 'journal' }],
  ['/connect.html', 'Connect', { page, area: 'sitemap', to: 'connect' }],
  ['/pricing.html', 'Pricing', { page, area: 'sitemap', to: 'pricing' }],
  ['/changelog.html', 'Changelog', { page, area: 'sitemap', to: 'changelog' }],
  ['/gallery', 'Gallery', { page, area: 'sitemap', to: 'gallery' }],
  ['/support.html', 'Support', { page, area: 'sitemap', to: 'support' }],
  ['/privacy.html', 'Privacy', { page, area: 'sitemap', to: 'privacy' }],
  ['/terms.html', 'Terms', { page, area: 'sitemap', to: 'terms' }],
  ['/refunds.html', 'Refunds', { page, area: 'sitemap', to: 'refunds' }],
];

// Each page's own links and its outline, as its contract words them.
const PAGES = {
  roadmap: {
    title: 'Skill Tree Maker for Real-Life Goals | Windmill Roadmap',
    links: [
      ['#/app/start', 'Start a tree', { area: 'first', to: 'room' }],
      ['#/demo', 'Try the live demo', { area: 'first', to: 'demo' }],
      ['/connect.html', 'How to connect', { area: 'section', to: 'connect' }],
      ['/gallery', 'See the gallery', { area: 'section', to: 'gallery' }],
      ['/privacy.html', 'Privacy', { area: 'feature', to: 'privacy' }],
      ['#/app/start', 'Start a tree', { area: 'closing', to: 'room' }],
    ],
    outline: [
      ['h1', 'A skill tree for real-life goals'],
      ['h2', 'Tell an AI your goal. Get a skill tree.'], ['h3', 'You grant the access'], ['h3', 'Its edits are yours to change'], ['h3', 'It cannot publish'],
      ['h2', 'What comes first, and what opens next'], ['h3', 'Locked, up next, done'], ['h3', 'The whole shape'], ['h3', 'No loops'],
      ['h2', 'Three ways to start a tree'], ['h3', 'Nine ready paths'], ['h3', 'Paste a list'], ['h3', 'Add more later'],
      ['h2', 'One step at a time'], ['h3', 'Trees inside trees'], ['h3', 'Find and filter'], ['h3', 'In a phone’s browser'],
      ['h2', 'Publish a tree, or keep it'], ['h3', 'Fork'], ['h3', 'The gallery'], ['h3', 'Private again'],
      ['h2', 'No account to begin'], ['h3', 'Works offline'], ['h3', 'Take it with you'], ['h3', 'Free by hand'],
      ['h2', 'What it will not do'], ['h3', 'Colour is not a grade'], ['h3', 'Opening Share changes nothing'], ['h3', 'Yours to edit'],
      ['h2', 'What stays in your browser, and what does not'], ['h3', 'A published tree'], ['h3', 'Your own assistant'], ['h3', 'Who else is involved'],
      ['h2', 'Questions'],
      ['h2', 'Plant your first tree.'],
    ],
    questions: ['What is a skill tree?', 'How do I make a skill tree for a real-life goal?', 'How do I break a big goal into steps?', 'What should I learn first?',
      'Can I create a skill tree from text, or have an AI write it?', 'Is it free, and do I need an account?', 'Can other people use my tree?'],
    frames: [['hero', 'Composed tree', ['narrow', 'wide']], ['root', 'Composed tree', ['narrow', 'column', 'row']], ['unlock', 'Composed tree', ['narrow', 'wide']],
      ['paths', 'Composed paths', ['narrow', 'wide']], ['step', 'Composed step', ['panel']], ['fork', 'Composed tree', ['narrow', 'wide']]],
  },
  gym: {
    title: 'Workout Log for Lifters on a Program | Windmill Gym',
    links: [
      ['#/gym', 'Open the log', { area: 'first', to: 'room' }],
      ['#where', 'Where it runs', { area: 'first', to: 'section' }],
      ['/pricing.html', 'Pricing', { area: 'section', to: 'pricing' }],
      ['/connect.html', 'How to connect', { area: 'section', to: 'connect' }],
      ['/privacy.html', 'Privacy', { area: 'section', to: 'privacy' }],
      ['#/gym', 'Open the log', { area: 'closing', to: 'room' }],
    ],
    outline: [
      ['h1', 'A workout log that remembers what you lifted'],
      ['h2', 'A coach that answers from your log'], ['h3', 'The read receipt'], ['h3', 'It waits to be asked'], ['h3', 'What it never does'],
      ['h2', 'Or bring your own assistant'], ['h3', 'Read'], ['h3', 'Write'], ['h3', 'Never'],
      ['h2', 'Your target, or last time’s numbers, before every set'], ['h3', 'On the lock screen'], ['h3', 'The finish receipt'], ['h3', 'Fix a set'],
      ['h2', 'How to track progressive overload'], ['h3', 'Estimated 1RM'], ['h3', 'Gaps stay gaps'], ['h3', 'Records'],
      ['h2', 'For the program you already run'], ['h3', 'Your movements'], ['h3', 'Show Coach a picture'], ['h3', 'Bodyweight'],
      ['h2', 'What it will not do'], ['h3', 'No change behind your back'], ['h3', 'No verdict on your body'], ['h3', 'No feed'],
      ['h2', 'What stays on your device, and what does not'], ['h3', 'Asking Coach'], ['h3', 'A share link'], ['h3', 'Your own assistant'],
      ['h2', 'Where it runs'], ['h3', 'Android'], ['h3', 'iPhone'], ['h3', 'Web'],
      ['h2', 'Questions'],
      ['h2', 'Bring the program you already run.'],
    ],
    questions: ['How do I track progressive overload?', 'Can I see what I lifted last time while I train?', 'When should I increase the weight?',
      'Will the AI coach change my program by itself?', 'Can Claude or another assistant read my workout log?', 'Is an estimated 1RM accurate?',
      'Can I log a workout in the browser?', 'Is it free?'],
    frames: [['logger', 'Composed session', ['narrow', 'wide']], ['root', 'Composed session', ['narrow', 'wide']], ['connect', 'Composed connection', ['narrow', 'wide']],
      ['remembered', 'Composed session', ['narrow', 'wide']], ['strength', 'Composed progress', ['narrow', 'wide']], ['routine', 'Composed routine', ['narrow', 'wide']]],
  },
  journal: {
    title: 'Journal App With Search by Meaning | Windmill Journal',
    links: [
      ['#/journal', 'Write tonight', { area: 'first', to: 'room' }],
      ['#echoes', 'See how it works', { area: 'first', to: 'section' }],
      ['/privacy.html', 'Privacy', { area: 'section', to: 'privacy' }],
      ['/pricing.html', 'Pricing', { area: 'feature', to: 'pricing' }],
      ['#/journal', 'Write tonight', { area: 'closing', to: 'room' }],
    ],
    outline: [
      ['h1', 'A daily journal you can search by meaning'],
      ['h2', 'Your own words, echoed back'], ['h3', 'Only your words'], ['h3', 'Follow it home'], ['h3', 'Free on a free account'],
      ['h2', 'Find what you wrote, without the exact words'], ['h3', 'On your device'], ['h3', 'Words first'], ['h3', 'On the web today'],
      ['h2', 'One page a night'], ['h3', 'Saves as you type'], ['h3', 'Works offline'], ['h3', 'Yesterday stays as written'],
      ['h2', 'Look back without a score'], ['h3', 'This week'], ['h3', 'Mood and energy, if you want'], ['h3', 'No praise for a number'],
      ['h2', 'Nothing writes back'], ['h3', 'No streaks'], ['h3', 'No prompts'], ['h3', 'No share button'],
      ['h2', 'What stays on your device, and what does not'], ['h3', 'Search stays local'], ['h3', 'Anthropic’s terms'], ['h3', 'No door for an assistant'],
      ['h2', 'Yours to keep, and where it runs'], ['h3', 'Leave whenever'], ['h3', 'Talk'], ['h3', 'The other rooms'],
      ['h2', 'Questions'],
      ['h2', 'Tonight’s page is waiting.'],
    ],
    questions: ['How do I find something I wrote if I don’t remember the words?', 'Should I reread my old journal?', 'What happens if I miss a day?',
      'Does the journal write back or ask me questions?', 'Is my journal private?', 'Can I journal online for free without signing up?', 'Does it use AI?'],
    frames: [['night', 'Composed page', ['narrow', 'wide']], ['root', 'Composed page', ['narrow', 'column', 'wide']], ['search', 'Composed page', ['narrow', 'wide']],
      ['write', 'Composed page', ['narrow', 'wide']], ['look_back', 'Composed year', ['narrow', 'wide']]],
  },
};

for (const [id, expected] of Object.entries(PAGES)) {
  test(`${id}: signed out, every link goes where its contract sends it and tells one front_link under the page ${id}, a double click too`, async (t) => {
    const page = await landing(t, id);
    assert.deepEqual(told(), [{ name: 'front_open', props: { page: id } }]);
    const links = [...CHROME_BEFORE(id), ...expected.links.map(([href, label, props]) => [href, label, { page: id, ...props }]), ...CHROME_AFTER(id)];
    assert.deepEqual(page.links.map((link) => [link.props.href, link.props['aria-label'] ?? textOf(link)]), links.map(([href, label]) => [href, label]));
    page.links.forEach((link) => { link.props.onClick({ detail: 1 }); link.props.onClick({ detail: 2 }); });
    assert.deepEqual(told(), links.map(([, , props]) => ({ name: 'front_link', props })));
    assert.deepEqual(page.links.filter((link) => link.props['aria-current']).map((link) => link.props.href), [`/${id}`]);
  });

  test(`${id}: one h1, its sections, features, questions and closing in its contract's order`, async (t) => {
    const page = await landing(t, id);
    told();
    assert.equal(page.frame.type.name, 'SiteFrame');
    assert.equal(page.frame.props.path, `/${id}`);
    assert.deepEqual(page.headings.map((heading) => [heading.type, textOf(heading)]), expected.outline);
    assert.deepEqual(page.main.filter((element) => element.type === 'dt').map(textOf), expected.questions);
    assert.deepEqual(page.main.filter((element) => element.type === 'dd').map(textOf), page.page.questions.map((entry) => entry.answer));
    const { LANDING_HEADS } = await loadScreen('shell/marketing/landingHeads.js');
    const head = LANDING_HEADS.find((each) => each.path === `/${id}`);
    assert.deepEqual([head.title, head.ogTitle, head.twitterTitle], [expected.title, expected.title, expected.title]);
    assert.deepEqual([head.ogDescription, head.twitterDescription], [head.description, head.description]);
  });

  test(`${id}: every picture sits in a frame labelled as composed, under the name its event tells, with the stages it is drawn at`, async (t) => {
    const page = await landing(t, id);
    told();
    assert.deepEqual(page.frames.map(({ props }) => [props.id, props.page, props.route, props.theme, props.picture.name, props.picture.label, props.picture.stages.map((stage) => stage.name)]),
      expected.frames.map(([name, label, stages]) => [id, id, `/${id}`, 'light', name, label, stages]));
  });

  test(`${id}: no line promises what the product does not do, names a price or links an About page`, async (t) => {
    const page = await landing(t, id);
    told();
    const words = page.main.filter((element) => ['h1', 'h2', 'h3', 'p', 'a', 'dt', 'dd'].includes(element.type)).map(textOf).join('  ');
    for (const refused of ['works for you', 'does it for you', 'About', 'training log', 'direct download', 'two taps', 'ten questions', 'With an account, export', 'kept only for you']) {
      assert.equal(words.includes(refused), false, refused);
    }
    assert.doesNotMatch(words, /[$€£]\s?\d|\d+\s?(USD|dollars)/);
    assert.equal((words.match(/Windmill One/g) ?? []).length, id === 'roadmap' ? 0 : 1);
  });

  test(`${id}: signed in, the seat stands where Sign in stood, and each control tells one front_control under the page ${id}`, async (t) => {
    const page = await landing(t, id, { status: 'signed-in', user: { name: 'Ada', email: 'ada@example.com' } });
    told();
    assert.deepEqual(page.buttons.map(textOf), ['Feedback']);
    page.buttons[0].props.onClick();
    assert.deepEqual(told(), [{ name: 'front_control', props: { page: id, control: 'feedback' } }]);
  });
}

test('every picture a landing draws carries a name web/OBSERVABILITY.md lists for front_picture, and every listed name is drawn', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../../OBSERVABILITY.md', import.meta.url), 'utf8');
  const listed = /\| `front_picture` \|[^\n]*`picture: ([\w/]+)`/.exec(doc)[1].split('/');
  const drawn = Object.values(PAGES).flatMap((expected) => expected.frames.map(([name]) => name));
  assert.deepEqual([...new Set(drawn)].sort(), [...listed].sort());
});
