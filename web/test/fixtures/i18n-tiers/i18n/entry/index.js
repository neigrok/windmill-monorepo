import { createTranslator } from '../../../../../src/platform/i18n/index.js';
import en from './en.json' with { type: 'json' };
import xx from './xx.json' with { type: 'json' };

export const catalogs = { en, xx };
export const t = createTranslator(catalogs);
