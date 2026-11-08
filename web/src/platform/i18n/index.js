import { createElement, Fragment } from 'react';
import { routeFamily } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';
import { formatMessage, parseMessage } from './message.js';

export const AVAILABLE_LOCALES = ['en'];

export function resolveLocale(requested, available = AVAILABLE_LOCALES) {
  const language = (tag) => tag.toLowerCase().split('-')[0];
  for (const tag of requested) {
    const exact = available.find((locale) => locale.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const sameLanguage = available.find((locale) => language(locale) === language(tag));
    if (sameLanguage) return sameLanguage;
  }
  return available[0];
}

export const APP_LOCALE = resolveLocale(globalThis.navigator?.languages ?? []);

function reportMissingMessage(key) {
  const route = typeof window === 'undefined' ? '' : routeFamily(window.location);
  captureError('i18n', 'i18n-missing-message', '', route, { key });
}

export function createTranslator(catalogs, { locale = APP_LOCALE, strict = !import.meta.env?.PROD, onMissing = reportMissingMessage } = {}) {
  const catalog = catalogs[locale];
  if (!catalog) throw new Error(`i18n: no ${locale} catalog`);
  const pluralRules = new Intl.PluralRules(locale);
  const parsed = new Map();
  const reported = new Set();

  const messageOf = (key) => {
    if (!parsed.has(key)) {
      if (!Object.hasOwn(catalog, key)) throw new Error(`the ${locale} catalog has no "${key}"`);
      parsed.set(key, parseMessage(catalog[key]));
    }
    return parsed.get(key);
  };

  return function t(key, args = {}) {
    try {
      const parts = formatMessage(messageOf(key), args, pluralRules);
      if (parts.every((part) => typeof part === 'string')) return parts.join('');
      return createElement(Fragment, null, ...parts);
    } catch (error) {
      if (strict) throw new Error(`i18n: "${key}" cannot be shown: ${error.message}`, { cause: error });
      if (!reported.has(key)) {
        reported.add(key);
        onMissing(key);
      }
      return key;
    }
  };
}
