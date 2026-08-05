// The crawlable shell /gym wears — head copy, structured data, and the words a visitor without
// JavaScript is served. Beside the landing it describes, because a page's words are its product's.
// Pure data, no browser globals: the build script reads this chain in plain Node.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';

export const gymLandingHead = {
  path: '/gym',
  module: 'src/products/gym/marketing/GymLanding.jsx',
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
};
