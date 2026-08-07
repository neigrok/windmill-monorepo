// Who stands behind every page, and the one share card they all unfurl with. Brand-level facts, so
// they live on the shell side and each product's landing head imports them rather than restating
// them — three copies of an organization block is three chances to disagree about our own name.
//
// Split out of landingHeads.js so a product's landing head can reach these without importing the
// shell's composition file, which imports the registry, which imports every product. Pure data and
// no imports of its own: scripts/build-landing-shells.mjs reads this chain in plain Node.

export const SITE_ORIGIN = 'https://windmill.works';

// og-image.png is the one share card the whole family owns, so its alt describes that card. A
// journal or gym link still unfurls with the roadmap's picture — the fix for that is art, not copy.
export const SHARE_CARD_ALT = 'The Windmill share card — a hand-drawn skill tree on a cream background with terracotta, gold, and sky nodes, and the Windmill wordmark.';

// One site and one publisher stand behind all four shells — only the page-level entities differ.
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
