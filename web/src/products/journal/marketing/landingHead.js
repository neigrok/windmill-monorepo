// Head copy, structured data, and the words a visitor without JavaScript is served. No browser globals
// and no .jsx import: the build script reads it in plain Node.

import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const journalLandingHead = {
  path: '/journal',
  module: 'src/products/journal/marketing/JournalLanding.jsx',
  title: t('journal.landingHead.title'),
  description: t('journal.landingHead.description'),
  ogTitle: t('journal.landingHead.shareTitle'),
  ogDescription: t('journal.landingHead.shareDescription'),
  twitterTitle: t('journal.landingHead.shareTitle'),
  twitterDescription: t('journal.landingHead.shareDescription'),
  imageAlt: SHARE_CARD_ALT,
  fallback: {
    accent: '#C29A4E',
    badge: t('journal.landing.hero.badge'),
    h1: t('journal.landing.hero.title'),
    sub: t('journal.landing.hero.sub'),
    actions: [
      { href: '#/journal', label: t('journal.landing.startWriting') },
      { href: '#how', label: t('journal.landing.seeHow') },
    ],
    trust: t('journal.landing.hero.trust'),
    notes: [
      t('journal.landingHead.howItWorks'),
      t('journal.landingHead.searchOnDevice'),
    ],
  },
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/journal#app`,
      'name': t('journal.landingHead.appName'),
      'url': `${SITE_ORIGIN}/journal`,
      'description': t('journal.landingHead.description'),
      'applicationCategory': 'LifestyleApplication',
      'operatingSystem': 'Web browser',
      'image': `${SITE_ORIGIN}/og-image.png`,
      'isAccessibleForFree': true,
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
