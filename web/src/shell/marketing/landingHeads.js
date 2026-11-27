// The crawlable shell each landing wears, by pathname; only the brand root's row is written here.
// Keep everything this file reaches pure data: no top-level .jsx import and no browser global, or
// plain Node can no longer resolve the landings. The '/' row is the shell web/index.html holds;
// edit them together.

import { PRODUCTS } from '../products.js';
import { SITE_ORIGIN, SITE_SCHEMA } from './siteIdentity.js';
import { t } from '../i18n/entry/index.js';

export { SITE_ORIGIN, SITE_SCHEMA };

// The shell's page every product's landing is drawn by; its shell preloads it beside the product's page.
export const PRODUCT_LANDING_MODULE = 'src/shell/marketing/ProductLanding.jsx';

// The root draws a row and a section for the open products alone, so the shell says exactly those.
const open = PRODUCTS.filter((product) => product.shell.status === 'open');

const BRAND_ROOT = {
  path: '/',
  title: t('shell.landingHead.title'),
  description: t('shell.landingHead.description'),
  ogTitle: t('shell.landingHead.title'),
  ogDescription: t('shell.landingHead.description'),
  twitterTitle: t('shell.landingHead.title'),
  twitterDescription: t('shell.landingHead.description'),
  imageAlt: t('shell.landingHead.imageAlt'),
  // The page's first screen and its three tools, in the page's own words.
  fallback: {
    h1: t('shell.landingHead.heading', { break: '' }),
    what: t('shell.landingHead.what'),
    stance: t('shell.landingHead.stance'),
    tools: open.map((product) => ({
      name: t('shell.brandLanding.toolName', { product: product.label }),
      kind: product.landing.root.kind,
      line: product.landing.root.line,
      link: { href: product.landing.root.link.href, label: product.landing.root.link.label },
    })),
  },
  schema: [],
};

export const LANDING_HEADS = [BRAND_ROOT, ...PRODUCTS.map((product) => product.landing.head)];
