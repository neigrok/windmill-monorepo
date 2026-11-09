import { SITE_ORIGIN, SHARE_CARD_ALT } from '../../../shell/marketing/siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export const gymLandingHead = {
  path: '/gym',
  module: 'src/products/gym/marketing/GymLanding.jsx',
  title: t('gym.landing.head.title'),
  description: t('gym.landing.head.description'),
  ogTitle: t('gym.landing.head.shareTitle'),
  ogDescription: t('gym.landing.head.shareDescription'),
  twitterTitle: t('gym.landing.head.shareTitle'),
  twitterDescription: t('gym.landing.head.shareDescription'),
  imageAlt: SHARE_CARD_ALT,
  fallback: {
    // --accent-iris-600 in styles/tokens/palettes.css.
    accent: '#4C4374',
    badge: t('gym.landing.hero.badge'),
    h1: t('gym.landing.hero.title'),
    sub: t('gym.landing.hero.sub'),
    actions: [
      { href: '#/gym', label: t('gym.landing.openLog') },
      { href: '#how', label: t('gym.landing.seeHow') },
    ],
    trust: t('gym.landing.accountLine'),
    notes: [
      t('gym.landing.head.notesHow'),
      t('gym.landing.head.notesLine'),
    ],
  },
  schema: [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_ORIGIN}/gym#app`,
      'name': 'Windmill Gym',
      'url': `${SITE_ORIGIN}/gym`,
      'description': t('gym.landing.head.schemaDescription'),
      'applicationCategory': 'HealthApplication',
      'operatingSystem': t('gym.landing.head.operatingSystem'),
      'image': `${SITE_ORIGIN}/og-image.png`,
      'isAccessibleForFree': true,
      'publisher': { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};
