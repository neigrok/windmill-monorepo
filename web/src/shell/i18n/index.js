import { createTranslator } from '../../platform/i18n/index.js';
import en from './en.json' with { type: 'json' };
import entryEn from './entry/en.json' with { type: 'json' };

export const t = createTranslator({ en: { ...entryEn, ...en } });
