// The crawlable shell each landing wears, by pathname: the <head> copy, the structured data, and
// the words a visitor without JavaScript is served. Pure data with no imports on purpose, because
// two very different readers need it. LandingChrome swaps the head strings in at runtime so a
// client-routed landing stops wearing the brand root's title, and scripts/build-landing-shells.mjs
// — a plain Node script, no bundler — renders every row into a static shell per path.
//
// The fallback body is here rather than in the build script for one reason: a landing that borrows
// the brand root's words tells a crawler something the page never says. Adding a row without one
// fails the build, so the lie cannot be shipped by omission.
//
// The '/' row is the exact shell web/index.html holds; edit them together, or the build says so.

export const SITE_ORIGIN = 'https://windmill.works';

// One site and one publisher stand behind all four shells — only the page-level entities differ.
export const SITE_SCHEMA = [
  {
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    'url': `${SITE_ORIGIN}/`,
    'name': 'Windmill',
    'description': 'Three self-growth tools on one account — Roadmap turns any goal into a living RPG skill tree, Journal is free-form daily writing that finds the feeling rather than the word, and Gym is a quiet training log, when it opens.',
    'inLanguage': 'en',
    'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
  },
  {
    '@type': 'Organization',
    '@id': `${SITE_ORIGIN}/#organization`,
    'name': 'Windmill',
    'url': `${SITE_ORIGIN}/`,
    'logo': {
      '@type': 'ImageObject',
      '@id': `${SITE_ORIGIN}/#logo`,
      'url': `${SITE_ORIGIN}/favicon.svg`,
      'caption': 'Windmill',
    },
    'image': { '@id': `${SITE_ORIGIN}/#logo` },
  },
];

// og-image.png is the one share card the whole family owns, so its alt describes that card. A
// journal or gym link still unfurls with the roadmap's picture — the fix for that is art, not copy.
const SHARE_CARD_ALT = 'The Windmill share card — a hand-drawn skill tree on a cream background with terracotta, gold, and sky nodes, and the Windmill wordmark.';

export const LANDING_HEADS = [
  {
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
      sub: 'Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, and a log for how you’re training, when it opens. One account. One subscription.',
      actions: [{ href: '/roadmap', label: 'Start with Roadmap' }],
      trust: 'Free to use by hand, all of it. The paid layer is only ever the AI doing the work for you.',
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
              'text': 'Windmill is free — building, sharing, exporting, and keeping a tree private cost nothing, and no account is needed to start. The one paid thing is tending: the AI that plants and reshapes your tree for you. Every account gets a free monthly allowance; Windmill Pro is $12 a month for a larger one, billed monthly, cancellable any time, with a 30-day money-back guarantee. Nothing that is free today moves behind the paywall.',
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
              'text': 'Every tree is a page. Send the link or post the picture, and anyone can fork a copy to grow their own version.',
            },
          },
          {
            '@type': 'Question',
            'name': 'Are there ready-made learning paths for developers?',
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': 'Yes. Windmill ships nine starter quests with real prerequisite logic — including Frontend, Rust from zero, ML foundations, and Ship v1.0 — adapted from the roadmap.sh community maps (CC BY-SA).',
            },
          },
        ],
      },
    ],
  },
  {
    path: '/roadmap',
    title: 'Windmill Roadmap — any goal, as a skill tree',
    description: 'Turn any goal or learning roadmap into an animated RPG skill tree. Finish a step, unlock the next branch. Free, no account — plant your first tree.',
    ogTitle: 'Windmill — Any goal, as a skill tree',
    ogDescription: 'Turn any plan — redecorating a room, learning to bake, training for a 10k, shipping a side project — into a living RPG skill tree. Finish a step, watch the next branch unlock. Public beta, no account needed.',
    twitterTitle: 'Windmill — Any goal, as a skill tree',
    twitterDescription: 'Turn any plan into a living RPG skill tree. Finish a step, watch the next branch unlock. Public beta — no account needed, your first tree lives in your browser.',
    imageAlt: 'A hand-drawn RPG skill tree on a cream background with terracotta, gold, and sky nodes, the Windmill wordmark, and the tagline “Any goal, as a skill tree.”',
    fallback: {
      accent: '#BC6C42',
      badge: 'Now in public beta',
      h1: 'Any goal, as a skill tree',
      sub: 'Redecorating a room, learning to bake, training for a 10k, or planning a side project — Windmill turns any plan into a living tree. Finish one step and watch the next branch unlock.',
      actions: [
        { href: '#/app/start', label: 'Start your tree' },
        { href: '#/demo', label: 'Try the live demo' },
      ],
      trust: 'No account needed — your first tree lives in your browser.',
      notes: [
        'How it works: Map your plan → Finish a step → Watch it unlock.',
        'Dev paths adapted from the roadmap.sh community maps (CC BY-SA).',
      ],
    },
    schema: [
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/roadmap#app`,
        'name': 'Windmill Roadmap',
        'url': `${SITE_ORIGIN}/roadmap`,
        'description': 'Windmill renders any roadmap or goal as an animated RPG skill tree. Map your plan, finish a step to ripen its fruit, and watch dependent branches light up. No account needed — your first tree lives in your browser — and every tree is a shareable, forkable page.',
        'applicationCategory': 'ProductivityApplication',
        'operatingSystem': 'Web browser',
        'browserRequirements': 'Requires a browser with WebGL2 support',
        'image': `${SITE_ORIGIN}/og-image.png`,
        'screenshot': `${SITE_ORIGIN}/og-image.png`,
        'softwareVersion': 'Public beta',
        'isAccessibleForFree': true,
        'featureList': [
          'Turn any plan into a living RPG skill tree with real prerequisite logic',
          'No account needed — your first tree lives in your browser',
          'Share any tree as a page; anyone can fork a copy and grow their own',
          'Speaks MCP so Claude, Cursor, or any agent can plant and tend a tree',
          'Sign in once and your trees sync across phone and desktop',
          'Authored developer learning paths adapted from roadmap.sh (CC BY-SA)',
        ],
        'offers': [
          {
            '@type': 'Offer',
            'name': 'Free',
            'price': '0',
            'priceCurrency': 'USD',
            'availability': 'https://schema.org/InStock',
            'url': `${SITE_ORIGIN}/pricing.html`,
            'description': 'All of Windmill, free: unlimited trees and steps, private trees, the whole editor, paste import, sharing, forking, export, the MCP server with an API key, and a monthly allowance of AI tendings.',
          },
          {
            '@type': 'Offer',
            'name': 'Windmill Pro',
            'price': '12',
            'priceCurrency': 'USD',
            'availability': 'https://schema.org/InStock',
            'url': `${SITE_ORIGIN}/pricing.html`,
            'description': 'A larger monthly allowance of tending — the AI that plants and reshapes your tree. Billed monthly, cancel any time, 30-day money-back guarantee.',
          },
        ],
        'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
      },
    ],
  },
  {
    path: '/journal',
    title: 'Windmill Journal — a place to notice what happened',
    description: 'A place to notice what happened. One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.',
    ogTitle: 'Windmill Journal — a place to notice what happened',
    ogDescription: 'One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.',
    twitterTitle: 'Windmill Journal — a place to notice what happened',
    twitterDescription: 'One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.',
    imageAlt: SHARE_CARD_ALT,
    fallback: {
      accent: '#C29A4E',
      badge: 'Now open',
      h1: 'A place to notice what happened.',
      sub: 'One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.',
      actions: [
        { href: '#/journal', label: 'Start writing' },
        { href: '#how', label: 'See how it works' },
      ],
      trust: 'And there is no share button — not switched off, just not there.',
      notes: [
        'How it works: Write → Look back → Hear it back.',
        'Search by meaning without your pages leaving your device.',
      ],
    },
    schema: [
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/journal#app`,
        'name': 'Windmill Journal',
        'url': `${SITE_ORIGIN}/journal`,
        'description': 'A place to notice what happened. One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.',
        'applicationCategory': 'LifestyleApplication',
        'operatingSystem': 'Web browser',
        'image': `${SITE_ORIGIN}/og-image.png`,
        'isAccessibleForFree': true,
        'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
      },
    ],
  },
  {
    path: '/gym',
    title: 'Windmill Gym — it remembers what you lifted',
    description: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and next session opens with last week’s numbers already in the field. In design — Gym joins the Windmill account and subscription when it opens.',
    ogTitle: 'Windmill Gym — it remembers what you lifted',
    ogDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and next session opens with last week’s numbers already in the field.',
    twitterTitle: 'Windmill Gym — it remembers what you lifted',
    twitterDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and next session opens with last week’s numbers already in the field.',
    imageAlt: SHARE_CARD_ALT,
    fallback: {
      accent: '#4A6875',
      badge: 'In design',
      h1: 'It remembers what you lifted.',
      sub: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, a small jump when it’s time, and next session opens with last week’s numbers already in the field.',
      actions: [
        { href: '/', label: 'See what’s already open →' },
        { href: '#how', label: 'See how it works' },
      ],
      trust: 'Gym joins the same account and subscription when it opens.',
      notes: ['How it works: Log the set → It remembers → See the line.'],
    },
    // In design: there is nothing to log yet, so this shell claims no application and no offer.
    schema: [],
  },
];
