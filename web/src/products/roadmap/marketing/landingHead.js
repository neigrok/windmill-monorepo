// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const roadmapLandingHead = {
  path: '/roadmap',
  module: 'src/products/roadmap/marketing/RoadmapLanding.jsx',
  title: t('roadmap.landingHead.title'),
  description: t('roadmap.landingHead.description'),
  ogTitle: t('roadmap.landingHead.socialTitle'),
  ogDescription: t('roadmap.landingHead.ogDescription'),
  twitterTitle: t('roadmap.landingHead.socialTitle'),
  twitterDescription: t('roadmap.landingHead.twitterDescription'),
  imageAlt: t('roadmap.landingHead.imageAlt'),
  fallback: {
    accent: '#BC6C42',
    badge: t('roadmap.landing.badge'),
    h1: t('roadmap.landing.title'),
    sub: t('roadmap.landing.sub'),
    actions: [
      { href: '#/app/start', label: t('roadmap.landing.start') },
      { href: '#/demo', label: t('roadmap.landing.tryDemo') },
    ],
    trust: t('roadmap.landing.firstTreeInBrowser'),
    notes: [
      t('roadmap.landingHead.fallbackHow'),
      t('roadmap.quests.attribution'),
    ],
  },
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/roadmap#app`,
      'name': 'Windmill Roadmap',
      'url': `${SITE_ORIGIN}/roadmap`,
      'description': t('roadmap.landingHead.schemaDescription'),
      'applicationCategory': 'ProductivityApplication',
      'operatingSystem': t('roadmap.landingHead.schemaOperatingSystem'),
      'browserRequirements': t('roadmap.landingHead.schemaBrowserRequirements'),
      'image': `${SITE_ORIGIN}/og-image.png`,
      'screenshot': `${SITE_ORIGIN}/og-image.png`,
      'softwareVersion': t('roadmap.landingHead.schemaVersion'),
      'isAccessibleForFree': true,
      'featureList': [
        t('roadmap.landingHead.featureTree'),
        t('roadmap.landingHead.featureNoAccount'),
        t('roadmap.landingHead.featureShare'),
        t('roadmap.landingHead.featureMcp'),
        t('roadmap.landingHead.featureSync'),
        t('roadmap.landingHead.featureQuests'),
      ],
      // Only an offer that is actually orderable belongs here.
      'offers': [
        {
          '@type': 'Offer',
          'name': t('roadmap.landingHead.offerName'),
          'price': '0',
          'priceCurrency': 'USD',
          'availability': 'https://schema.org/InStock',
          'url': `${SITE_ORIGIN}/pricing.html`,
          'description': t('roadmap.landingHead.offerDescription'),
        },
      ],
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
