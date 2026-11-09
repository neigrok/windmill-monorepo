// Pure data with no browser globals, so scripts/build-landing-shells.mjs can read it in Node.

import { t } from '../i18n/index.js';

export const SITE_ORIGIN = 'https://windmill.works';

export const SHARE_CARD_ALT = t('shell.site.shareCardAlt');

export const SITE_SCHEMA = [
  {
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    'url': `${SITE_ORIGIN}/`,
    'name': 'Windmill',
    'description': t('shell.site.description'),
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
      'url': `${SITE_ORIGIN}/brand-logo.svg`,
      'caption': 'Windmill',
    },
    'image': { '@id': `${SITE_ORIGIN}/#logo` },
  },
];

export const LEGAL_SHELF_LABEL = t('shell.site.legalShelf');

export const LEGAL_LINKS = [
  { href: '/pricing.html', label: t('shell.site.pricing') },
  { href: '/privacy.html', label: t('shell.site.privacy') },
  { href: '/terms.html', label: t('shell.site.terms') },
  { href: '/refunds.html', label: t('shell.site.refunds') },
  { href: '/changelog.html', label: t('shell.site.changelog') },
];

export const PRODUCT_SHELF_LABEL = t('shell.site.productShelf');

export const SURFACE_LINKS = [
  { href: '/gallery', label: t('shell.site.gallery') },
  { href: '/connect.html', label: t('shell.site.connect') },
];
