// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const gymLandingHead = {
  path: '/gym',
  module: 'src/products/gym/marketing/landingPage.js',
  title: t('gym.landingHead.title'),
  description: t('gym.landingHead.description'),
  ogTitle: t('gym.landingHead.title'),
  ogDescription: t('gym.landingHead.description'),
  twitterTitle: t('gym.landingHead.title'),
  twitterDescription: t('gym.landingHead.description'),
  imageAlt: SHARE_CARD_ALT,
  // Web only until an app has a public listing; then its platform and download address join here.
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/gym#app`,
      'name': 'Windmill Gym',
      'url': `${SITE_ORIGIN}/gym`,
      'description': t('gym.landingHead.description'),
      'applicationCategory': 'HealthApplication',
      'operatingSystem': t('gym.landingHead.operatingSystem'),
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
