// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const roadmapLandingHead = {
  path: '/roadmap',
  module: 'src/products/roadmap/marketing/landingPage.js',
  title: t('roadmap.landingHead.title'),
  description: t('roadmap.landingHead.description'),
  ogTitle: t('roadmap.landingHead.title'),
  ogDescription: t('roadmap.landingHead.description'),
  twitterTitle: t('roadmap.landingHead.title'),
  twitterDescription: t('roadmap.landingHead.description'),
  imageAlt: t('roadmap.landingHead.imageAlt'),
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/roadmap#app`,
      'name': 'Windmill Roadmap',
      'url': `${SITE_ORIGIN}/roadmap`,
      'description': t('roadmap.landingHead.description'),
      'applicationCategory': 'ProductivityApplication',
      'operatingSystem': t('roadmap.landingHead.operatingSystem'),
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
