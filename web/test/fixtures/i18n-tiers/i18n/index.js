import { createTranslator } from '../../../../src/platform/i18n/index.js';
import entryEn from './entry/en.json' with { type: 'json' };
import entryXx from './entry/xx.json' with { type: 'json' };
import landingEn from './landing/en.json' with { type: 'json' };
import landingXx from './landing/xx.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };
import xx from './xx.json' with { type: 'json' };

export const catalogs = { en: { ...entryEn, ...landingEn, ...en }, xx: { ...entryXx, ...landingXx, ...xx } };
export const t = createTranslator(catalogs);
