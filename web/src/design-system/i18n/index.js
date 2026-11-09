import { createTranslator } from '../../platform/i18n/index.js';
import en from './en.json' with { type: 'json' };

export const catalogs = { en };
export const t = createTranslator(catalogs);
