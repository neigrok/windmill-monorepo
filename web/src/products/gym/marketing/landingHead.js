import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';

export const gymLandingHead = {
  path: '/gym',
  module: 'src/products/gym/marketing/GymLanding.jsx',
  title: 'Windmill Gym — a training log that remembers what you lifted',
  description: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field. e1RM per lift over time, a link that hands one workout to your coach, and a CSV of every set you have logged.',
  ogTitle: 'Windmill Gym — it remembers what you lifted',
  ogDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field.',
  twitterTitle: 'Windmill Gym — it remembers what you lifted',
  twitterDescription: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, and the next session opens with last time’s numbers already in the field.',
  imageAlt: SHARE_CARD_ALT,
  fallback: {
    // --accent-iris-600 in styles/tokens/palettes.css.
    accent: '#4C4374',
    badge: 'Barbell training log',
    h1: 'It remembers what you lifted.',
    sub: 'A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps between sets, a small jump when it’s time, and the next session opens with last time’s numbers already in the field.',
    actions: [
      { href: '#/gym', label: 'Open your training log →' },
      { href: '#how', label: 'See how it works' },
    ],
    trust: 'Your log lives on your Windmill account — one account across Roadmap, Journal and Gym.',
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
