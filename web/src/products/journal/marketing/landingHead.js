// scripts/build-landing-shells.mjs reads this chain in plain Node: no .jsx imports, no browser globals.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const journalLandingHead = {
  path: '/journal',
  module: 'src/products/journal/marketing/landingPage.js',
  title: t('journal.landingHead.title'),
  description: t('journal.landingHead.description'),
  ogTitle: t('journal.landingHead.title'),
  ogDescription: t('journal.landingHead.description'),
  twitterTitle: t('journal.landingHead.title'),
  twitterDescription: t('journal.landingHead.description'),
  imageAlt: SHARE_CARD_ALT,
  // Web only until the iPhone app has a public listing; then its platform joins here.
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/journal#app`,
      'name': 'Windmill Journal',
      'url': `${SITE_ORIGIN}/journal`,
      'description': t('journal.landingHead.description'),
      'applicationCategory': 'LifestyleApplication',
      'operatingSystem': t('journal.landingHead.operatingSystem'),
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
