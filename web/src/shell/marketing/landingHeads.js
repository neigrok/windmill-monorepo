// The crawlable shell each landing wears, by pathname; only the brand root's row is written here.
// Keep everything this file reaches pure data: no top-level .jsx import and no browser global, or
// plain Node can no longer resolve the landings. The '/' row is the shell web/index.html holds;
// edit them together.
//
// The front door's two facts live here too, and BrandLanding reads them from here rather than
// saying them again: the sentence the page and the shell both carry as their <h1>, and the one
// place "Start free" opens. One label pointing two ways is what saying them twice buys.

import { PRODUCTS } from '../products.js';
import { SITE_ORIGIN, SITE_SCHEMA } from './siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export { SITE_ORIGIN, SITE_SCHEMA };

// The root draws a band and a section for the open products alone, so the shell says exactly those.
const open = PRODUCTS.filter((product) => product.shell.status === 'open');

export const BRAND_PROMISE = t('shell.landingHead.promise');
export const START_FREE = open.length > 0
  ? { href: open[0].landing.root.section.cta.href, label: t('shell.landingHead.startFree') }
  : null;

const BRAND_ROOT = {
  path: '/',
  title: t('shell.landingHead.title'),
  description: t('shell.landingHead.description'),
  ogTitle: t('shell.landingHead.socialTitle', { promise: BRAND_PROMISE }),
  ogDescription: t('shell.landingHead.description'),
  twitterTitle: t('shell.landingHead.socialTitle', { promise: BRAND_PROMISE }),
  twitterDescription: t('shell.landingHead.description'),
  imageAlt: t('shell.landingHead.imageAlt'),
  fallback: {
    accent: '#BC6C42',
    badge: t('shell.landingHead.badge'),
    h1: BRAND_PROMISE,
    sub: t('shell.landingHead.description'),
    actions: START_FREE ? [START_FREE] : [],
    trust: t('shell.landingHead.trust'),
    // The hero bands' promises, read off the bands the page really draws.
    notes: open.map((product) => product.landing.root.band.title),
  },
  schema: [
    {
      '@type': 'FAQPage',
      '@id': `${SITE_ORIGIN}/#faq`,
      'url': `${SITE_ORIGIN}/`,
      'isPartOf': { '@id': `${SITE_ORIGIN}/#website` },
      'mainEntity': [
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.accountQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.accountAnswer'),
          },
        },
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.costQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.costAnswer'),
          },
        },
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.devicesQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.devicesAnswer'),
          },
        },
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.agentsQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.agentsAnswer'),
          },
        },
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.sharingQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.sharingAnswer'),
          },
        },
        {
          '@type': 'Question',
          'name': t('shell.landingHead.faq.pathsQuestion'),
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': t('shell.landingHead.faq.pathsAnswer'),
          },
        },
      ],
    },
  ],
};

export const LANDING_HEADS = [BRAND_ROOT, ...PRODUCTS.map((product) => product.landing.head)];
