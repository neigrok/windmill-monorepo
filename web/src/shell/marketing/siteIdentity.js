// Pure data with no imports of its own, so scripts/build-landing-shells.mjs can read it in Node.

export const SITE_ORIGIN = 'https://windmill.works';

export const SHARE_CARD_ALT = 'The Windmill share card — a hand-drawn skill tree on a cream background with terracotta, gold, and sky nodes, and the Windmill wordmark.';

export const SITE_SCHEMA = [
  {
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    'url': `${SITE_ORIGIN}/`,
    'name': 'Windmill',
    'description': 'Three self-growth tools on one account — Roadmap turns any goal into a living RPG skill tree, Journal is free-form daily writing that finds the feeling rather than the word, and Gym is a quiet training log.',
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

export const LEGAL_LINKS = [
  { href: '/pricing.html', label: 'Pricing' },
  { href: '/privacy.html', label: 'Privacy' },
  { href: '/terms.html', label: 'Terms' },
  { href: '/refunds.html', label: 'Refunds' },
  { href: '/changelog.html', label: 'Changelog' },
];

export const SURFACE_LINKS = [
  { href: '/gallery', label: 'Gallery' },
  { href: '/connect.html', label: 'Connect' },
];
