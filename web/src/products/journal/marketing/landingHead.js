// The crawlable shell /journal wears — head copy, structured data, and the words a visitor without
// JavaScript is served. Beside the landing it describes, because a page's words are its product's.
// Pure data, no browser globals: the build script reads this chain in plain Node.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';

export const journalLandingHead = {
  path: '/journal',
  module: 'src/products/journal/marketing/JournalLanding.jsx',
  // The SERP title names the thing and then says it in our voice; ogTitle and twitterTitle below
  // stay pure voice, because a share card is read by someone who already clicked, and a search
  // result by someone typing "daily journal". Same page, two readers, two first lines.
  title: 'Windmill Journal — a daily journal for noticing what happened',
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
};
