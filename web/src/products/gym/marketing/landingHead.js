// The crawlable shell /gym wears — head copy, structured data, and the words a visitor without
// JavaScript is served. Beside the landing it describes, because a page's words are its product's.
// Pure data, no browser globals: the build script reads this chain in plain Node.
//
// Every line here describes what the product DOES, and none of them describes when it arrives. That
// is deliberate: gym is complete and reachable at #/gym while `shell.status` is still 'pre-open'
// (products/gym/routes.js), so a sentence dated against that word was false the day it was written
// and would be false again the day the word moves. The one action is the same door in both states —
// #/gym renders the log today and upgrades in place to /app/gym the moment gym opens.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';

export const gymLandingHead = {
  path: '/gym',
  module: 'src/products/gym/marketing/GymLanding.jsx',
  title: 'Windmill Gym — it remembers what you lifted',
  description: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field. e1RM per lift over time, a link that hands one workout to your coach, and a CSV of every set you have logged.',
  ogTitle: 'Windmill Gym — it remembers what you lifted',
  ogDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field.',
  twitterTitle: 'Windmill Gym — it remembers what you lifted',
  twitterDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field.',
  imageAlt: SHARE_CARD_ALT,
  fallback: {
    accent: '#4A6875',
    badge: 'Barbell training log',
    h1: 'It remembers what you lifted.',
    sub: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, a small jump when it’s time, and the next session opens with last time’s numbers already in the field.',
    actions: [
      { href: '#/gym', label: 'Open your training log →' },
      { href: '#how', label: 'See how it works' },
    ],
    // The precondition, said at the door rather than behind it: gym answers a visitor with no
    // account with a sign-in pitch, and a log kept on an account is the honest reason why.
    trust: 'Your log lives on your Windmill account — one account and one subscription across Roadmap, Journal and Gym.',
    notes: [
      'How it works: Log the set → It remembers → See the line.',
      'e1RM per lift over time, a link that hands one workout to your coach, and a CSV of every set.',
    ],
  },
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/gym#app`,
      'name': 'Windmill Gym',
      'url': `${SITE_ORIGIN}/gym`,
      'description': 'A training log for barbell programs. Log a set in two taps, and the next session opens with last time’s numbers already in the field. e1RM per lift over time, working sets and sessions per week, a revocable link that hands one workout to a coach, and a CSV of every set.',
      'applicationCategory': 'HealthApplication',
      'operatingSystem': 'Web browser',
      'image': `${SITE_ORIGIN}/og-image.png`,
      'isAccessibleForFree': true,
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
