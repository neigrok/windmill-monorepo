import { createElement, Fragment } from 'react';
import { routeFamily } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';
import { formatMessage, MessageError, parseMessage } from './message.js';

export const AVAILABLE_LOCALES = ['en'];

export function resolveLocale(requested, available = AVAILABLE_LOCALES) {
  const normal = (tag) => String(tag).toLowerCase().replaceAll('_', '-');
  const language = (tag) => normal(tag).split('-')[0];
  for (const tag of requested) {
    const exact = available.find((locale) => normal(locale) === normal(tag));
    if (exact) return exact;
    const sameLanguage = available.find((locale) => language(locale) === language(tag));
    if (sameLanguage) return sameLanguage;
  }
  return available[0];
}

export const APP_LOCALE = typeof document === 'undefined'
  ? AVAILABLE_LOCALES[0]
  : resolveLocale(globalThis.navigator?.languages ?? []);

function reportMissingMessage(key, reason) {
  const route = typeof window === 'undefined' ? '' : routeFamily(window.location);
  captureError('i18n', 'i18n-missing-message', '', route, { key, reason });
}

export function createTranslator(catalogs, {
  locale = APP_LOCALE, available = AVAILABLE_LOCALES, strict = !import.meta.env?.PROD, onMissing = reportMissingMessage,
} = {}) {
  const absent = [...new Set([...available, locale])].filter((name) => !catalogs[name]);
  if (absent.length) throw new Error(`i18n: no ${absent.join(', ')} catalog`);
  const catalog = catalogs[locale];
  const pluralRules = new Intl.PluralRules(locale);
  const parsed = new Map();
  const reported = new Set();

  const messageOf = (key) => {
    if (!parsed.has(key)) {
      if (!Object.hasOwn(catalog, key)) throw new MessageError('key', `the ${locale} catalog has no "${key}"`);
      parsed.set(key, parseMessage(catalog[key]));
    }
    return parsed.get(key);
  };
  const report = (key, reason) => {
    if (reported.has(key)) return;
    reported.add(key);
    onMissing(key, reason);
  };

  return function t(key, args = {}) {
    try {
      const parts = formatMessage(messageOf(key), args, pluralRules, strict ? undefined : () => report(key, 'count'));
      if (parts.every((part) => typeof part === 'string')) return parts.join('');
      return createElement(Fragment, null, ...parts);
    } catch (error) {
      if (strict) throw new Error(`i18n: "${key}" cannot be shown: ${error.message}`, { cause: error });
      report(key, error instanceof SyntaxError ? 'syntax' : error.reason);
      return key;
    }
  };
}
