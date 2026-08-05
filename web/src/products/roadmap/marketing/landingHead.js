// The crawlable shell /roadmap wears: the <head> copy, the structured data, and the words a
// visitor without JavaScript is served. It lives here, beside the landing it describes, for the
// same reason the landing does — a page's words are its product's, and the shell must not hold a
// sentence about roadmaps. The shell composes these off the registry (shell/marketing/landingHeads.js).
//
// Pure data, no imports: scripts/build-landing-shells.mjs reads this chain in plain Node, with no
// bundler, so nothing here may reach for a .jsx or a browser global.
//
// `module` is this landing's own source file. The build script looks it up in Vite's manifest and
// preloads that chunk from the shell, so the request goes out with the HTML instead of waiting for
// the entry chunk to download, parse and discover it — one serial round trip the visitor watches.
// It names a sibling of this file, which is why it is stated here and not on the shell side.

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
          'name': 'Windmill One',
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
};
