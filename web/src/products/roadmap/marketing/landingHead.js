// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const roadmapLandingHead = {
  path: '/roadmap',
  module: 'src/products/roadmap/marketing/RoadmapLanding.jsx',
  title: t('roadmap.head.title'),
  description: t('roadmap.head.description'),
  ogTitle: t('roadmap.head.socialTitle'),
  ogDescription: t('roadmap.head.ogDescription'),
  twitterTitle: t('roadmap.head.socialTitle'),
  twitterDescription: t('roadmap.head.twitterDescription'),
  imageAlt: t('roadmap.head.imageAlt'),
  fallback: {
    accent: '#BC6C42',
    badge: t('roadmap.landing.badge'),
    h1: t('roadmap.landing.title'),
    sub: t('roadmap.landing.sub'),
    actions: [
      { href: '#/app/start', label: t('roadmap.landing.start') },
      { href: '#/demo', label: t('roadmap.landing.tryDemo') },
    ],
    trust: t('roadmap.firstTreeInBrowser'),
    notes: [
      t('roadmap.head.fallbackHow'),
      t('roadmap.questsAttribution'),
    ],
  },
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/roadmap#app`,
      'name': 'Windmill Roadmap',
      'url': `${SITE_ORIGIN}/roadmap`,
      'description': t('roadmap.head.schemaDescription'),
      'applicationCategory': 'ProductivityApplication',
      'operatingSystem': t('roadmap.head.schemaOperatingSystem'),
      'browserRequirements': t('roadmap.head.schemaBrowserRequirements'),
      'image': `${SITE_ORIGIN}/og-image.png`,
      'screenshot': `${SITE_ORIGIN}/og-image.png`,
      'softwareVersion': t('roadmap.head.schemaVersion'),
      'isAccessibleForFree': true,
      'featureList': [
        t('roadmap.head.featureTree'),
        t('roadmap.head.featureNoAccount'),
        t('roadmap.head.featureShare'),
        t('roadmap.head.featureMcp'),
        t('roadmap.head.featureSync'),
        t('roadmap.head.featureQuests'),
      ],
      // Only an offer that is actually orderable belongs here.
      'offers': [
        {
          '@type': 'Offer',
          'name': t('roadmap.head.offerName'),
          'price': '0',
          'priceCurrency': 'USD',
          'availability': 'https://schema.org/InStock',
          'url': `${SITE_ORIGIN}/pricing.html`,
          'description': t('roadmap.head.offerDescription'),
        },
      ],
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
