// The crawlable shell each landing wears, by pathname; only the brand root's row is written here.
// Keep everything this file reaches pure data: no top-level .jsx import and no browser global, or
// plain Node can no longer resolve the landings. The '/' row is the shell web/index.html holds;
// edit them together.
//
// The front door's two facts live here too, and BrandLanding reads them from here rather than
// saying them again: the sentence the page and the shell both carry as their <h1>, and the one
// place "Start free" opens. One label pointing two ways is what saying them twice buys.

import { PRODUCTS } from '../products.js';
import { SITE_ORIGIN, SITE_SCHEMA } from './siteIdentity.js';

export { SITE_ORIGIN, SITE_SCHEMA };

// The root draws a band and a section for the open products alone, so the shell says exactly those.
const open = PRODUCTS.filter((product) => product.shell.status === 'open');

export const BRAND_PROMISE = 'Three tools. One account.';
export const START_FREE = open.length > 0
  ? { href: open[0].landing.root.section.cta.href, label: 'Start free' }
  : null;

const BRAND_ROOT = {
  path: '/',
  title: 'Windmill — Roadmap, Journal & Gym for self-growth',
  description: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  ogTitle: `Windmill — ${BRAND_PROMISE}`,
  ogDescription: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  twitterTitle: `Windmill — ${BRAND_PROMISE}`,
  twitterDescription: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  imageAlt: 'A hand-drawn RPG skill tree on a cream background with terracotta, gold, and sky nodes, the Windmill wordmark, and the tagline “Any goal, as a skill tree.”',
  fallback: {
    accent: '#BC6C42',
    badge: 'Roadmap · Journal · Gym',
    h1: BRAND_PROMISE,
    sub: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
    actions: START_FREE ? [START_FREE] : [],
    trust: 'Free to use by hand, all of it. The paid layer is the AI doing the work for you — and it is not on sale yet.',
    // The hero bands' promises, read off the bands the page really draws.
    notes: open.map((product) => product.landing.root.band.title),
  },
  schema: [
    {
      '@type': 'FAQPage',
      '@id': `${SITE_ORIGIN}/#faq`,
      'url': `${SITE_ORIGIN}/`,
      'isPartOf': { '@id': `${SITE_ORIGIN}/#website` },
      'mainEntity': [
        {
          '@type': 'Question',
          'name': 'Do I need an account to use Windmill?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'No. No account is needed to start — your first tree lives right in your browser. Sign in only when you want your trees to sync across devices.',
          },
        },
        {
          '@type': 'Question',
          'name': 'How much does Windmill cost?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'Windmill is free — building, sharing, exporting, and keeping a tree private cost nothing, and no account is needed to start. Nothing is on sale today: Windmill One is not open, and no card is asked for anywhere in Windmill. What it will cover when it opens is the AI doing the work for you: tending in the roadmap, Talk and echoes in the journal — one plan at $12 a month. In Gym, the log, the connected log and Coach — ten questions a day — cost nothing; a plan only raises the AI ceiling behind Coach. Tending itself is not switched on yet. Nothing that is free today moves behind the paywall.',
          },
        },
        {
          '@type': 'Question',
          'name': 'Does Windmill work on my phone and my computer?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'Yes. Sign in once and your trees follow you — check a step off on your phone and tend the branches at your desk.',
          },
        },
        {
          '@type': 'Question',
          'name': 'Can Claude, Cursor, or other AI agents build trees for me?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'Yes. Windmill speaks MCP (Model Context Protocol), so Claude, Cursor, or any compatible agent can plant and tend a tree alongside you.',
          },
        },
        {
          '@type': 'Question',
          'name': 'Can I share a tree with other people?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'Trees start private. Share one and it becomes a page anyone holding the link can open — and anyone who opens it can fork a copy to grow their own version.',
          },
        },
        {
          '@type': 'Question',
          'name': 'Are there ready-made learning paths for developers?',
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': 'Yes. Windmill ships nine starter quests with real prerequisite logic. Three of the developer paths — Frontend path, Rust from zero and ML foundations — are adapted from the roadmap.sh community maps (CC BY-SA); the rest, including Ship v1, are Windmill’s own.',
          },
        },
      ],
    },
  ],
};

export const LANDING_HEADS = [BRAND_ROOT, ...PRODUCTS.map((product) => product.landing.head)];
