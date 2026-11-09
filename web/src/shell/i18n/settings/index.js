import { createTranslator } from '../../../platform/i18n/index.js';
import entryEn from '../entry/en.json' with { type: 'json' };
import appEn from '../app/en.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export const catalogs = { en: { ...entryEn, ...appEn, ...en } };
export const t = createTranslator(catalogs);
