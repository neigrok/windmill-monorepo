// The crawlable shell each landing wears, by pathname — composed, not authored. Two very different
// readers need this list: LandingChrome swaps the head strings in at runtime so a client-routed
// landing stops wearing the brand root's title, and scripts/build-landing-shells.mjs — a plain Node
// script, no bundler — renders every row into a static shell per path.
//
// Only the brand root's row is written here, because the brand root is the shell's own page. Each
// product's row lives with the product (products/<p>/marketing/landingHead.js) and arrives through
// the registry, the one meeting point between chrome and products. That is why this file holds no
// path into a product source tree any more: a landing names its own module, from beside it.
//
// The plain-Node half is why the whole head chain stays pure data. It reads fine: products.js pulls
// each product's routes.js, whose components are lazy(() => import(...)) — a dynamic import that
// never runs at module load — so Node resolves the chain with no bundler and without touching a
// .jsx. That was measured, not assumed. Do not put a top-level .jsx import or a browser global into
// anything this file reaches, or the build stops being able to see the landings.
//
// The fallback body is data rather than markup in the build script for one reason: a landing that
// borrows the brand root's words tells a crawler something the page never says. Adding a row
// without one fails the build, so the lie cannot be shipped by omission.
//
// The '/' row is the exact shell web/index.html holds; edit them together, or the build says so.

import { PRODUCTS } from '../products.js';
import { SITE_ORIGIN, SITE_SCHEMA } from './siteIdentity.js';

export { SITE_ORIGIN, SITE_SCHEMA };

// The brand root has one door, not three: the first product the registry calls open. Derived off
// the same registry BrandLanding derives its hero from, so the crawlable twin and the running page
// cannot drift. Before this they were written out by hand in three places and agreed only because
// someone kept them agreeing.
const start = PRODUCTS.find((product) => product.shell.status === 'open');

const BRAND_ROOT = {
  path: '/',
  title: 'Windmill — Roadmap, Journal & Gym for self-growth',
  description: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  ogTitle: 'Windmill — Grow, gently.',
  ogDescription: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  twitterTitle: 'Windmill — Grow, gently.',
  twitterDescription: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription.',
  imageAlt: 'A hand-drawn RPG skill tree on a cream background with terracotta, gold, and sky nodes, the Windmill wordmark, and the tagline “Any goal, as a skill tree.”',
  fallback: {
    accent: '#BC6C42',
    badge: 'Now in public beta',
    h1: 'Grow, gently.',
    sub: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, and a log for how you’re training. One account. One subscription.',
    actions: start ? [{ href: start.landing.href, label: `Start with ${start.label}` }] : [],
    trust: 'Free to use by hand, all of it. The paid layer is the AI doing the work for you — and it is not on sale yet.',
    notes: [
      'Three tools, one account.',
      'Whichever tool you open, it’s the same account — and the roadmap doesn’t need one to begin.',
    ],
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
            'text': 'Windmill is free — building, sharing, exporting, and keeping a tree private cost nothing, and no account is needed to start. Nothing is on sale today: Windmill One is not open, and no card is asked for anywhere in Windmill. What it will cover when it opens is the AI doing the work for you: tending in the roadmap, Talk and echoes in the journal, the coach in the gym — one plan at $12 a month. Tending itself is not switched on yet. Nothing that is free today moves behind the paywall.',
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

// Brand root first, then the products in rail order — the order the build script emits shells in,
// and the order a reader meets them on the site.
export const LANDING_HEADS = [BRAND_ROOT, ...PRODUCTS.map((product) => product.landing.head)];
