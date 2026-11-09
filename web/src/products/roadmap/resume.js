// The newest roadmap as the home card and the landing offer it back: its name, a short name for a button, how
// long ago it was tended, and the sentence that says so around a progress figure each surface draws its own way.

import { t } from './i18n/landing/index.js';

export function tendedAgo(updatedAt) {
  if (updatedAt == null) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return t('roadmap.ago.justNow');
  if (mins < 60) return t('roadmap.ago.minutes', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('roadmap.ago.hours', { count: hrs });
  const days = Math.round(hrs / 24);
  if (days < 7) return t('roadmap.ago.days', { count: days });
  return t('roadmap.ago.weeks', { count: Math.round(days / 7) });
}

export function resumeOf(tree) {
  const name = tree.title?.trim() || t('roadmap.common.untitled');
  const chars = Array.from(name); // cut by code points — an emoji never splits
  return { name, shortName: chars.length > 18 ? `${chars.slice(0, 17).join('').trimEnd()}…` : name, tended: tendedAgo(tree.updatedAt) };
}

export function resumeSummary({ name, tended }, progress) {
  return tended ? t('roadmap.resume.summaryTended', { name, progress, tended }) : t('roadmap.resume.summary', { name, progress });
}
