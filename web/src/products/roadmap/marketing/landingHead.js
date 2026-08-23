// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN } from '../../../shell/marketing/siteIdentity.js';

export const roadmapLandingHead = {
  path: '/roadmap',
  module: 'src/products/roadmap/marketing/RoadmapLanding.jsx',
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
      'Three of the dev paths adapted from the roadmap.sh community maps (CC BY-SA).',
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
        'Nine authored starter quests; three of the developer paths adapted from roadmap.sh (CC BY-SA)',
      ],
      // Only an offer that is actually orderable belongs here.
      'offers': [
        {
          '@type': 'Offer',
          'name': 'Free',
          'price': '0',
          'priceCurrency': 'USD',
          'availability': 'https://schema.org/InStock',
          'url': `${SITE_ORIGIN}/pricing.html`,
          'description': 'All of Windmill, free: as many trees as you like, up to 10,000 steps in each, private trees, the whole editor, paste import, sharing, forking, export, and the MCP server with an API key. Tending — the AI that plants and reshapes a tree — is not switched on yet. When it is, a free account gets a monthly allowance of it.',
        },
      ],
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
