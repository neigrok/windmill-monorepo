import { Bodyweight } from '../domain/bodyweight.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { failureReason, isStoreFailure } from '../errors.js';
import { t } from '../i18n/entry/index.js';
import { agoLabel, shortDayLabel } from '../log.js';
import { inDisplayUnit, LB, weightUnit } from '../units.js';

export const BODYWEIGHT_TITLE = t('gym.bodyweight.title');
export const WEIGH_IN_VERB = t('gym.bodyweight.weighIn');
export const DATE_LABEL = t('gym.bodyweight.date');
export const SAVE_VERB = t('gym.bodyweight.save');
export const NO_WEIGH_INS = t('gym.bodyweight.empty');
export const NO_WEIGH_INS_LINE = t('gym.bodyweight.emptyLine');
export const NO_WEIGH_INS_IN_WINDOW = t('gym.bodyweight.emptyWindow');
export const OPENING = t('gym.bodyweight.opening');
export const FAILED = t('gym.bodyweight.failed');

export const DELETE_VERB = t('gym.bodyweight.delete');

// One press, and the way back is the window's Undo rather than a question in front of the act.
export const WEIGH_IN_DELETED = t('gym.bodyweight.deleted');

export const REFUSALS = {
  notNumber: t('gym.bodyweight.notNumber'),
  decimals: t('gym.bodyweight.decimals'),
  bounds: t('gym.bodyweight.bounds'),
  future: t('gym.bodyweight.future'),
};

// `label` is the control's word; `chartCaption` states the window it shows.
export const WINDOWS = [
  { id: '90', label: t('gym.bodyweight.window90') },
  { id: 'all', label: t('gym.bodyweight.windowAll') },
];
export const DEFAULT_WINDOW = '90';

// Local midnight is only a chart and label coordinate; calendar validity belongs to LocalDay.
export function msOfDateLocal(text) {
  const day = LocalDay.parse(text ?? '');
  if (!day) return null;
  const date = new Date(0);
  date.setFullYear(day.year, day.month - 1, day.day);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// The number in the display unit: kilograms to the two decimals the wire carries, trailing zeros
// dropped; pounds to a tenth (units.js). Never rounded past what was typed.
export function weightReading(weightKg, unit = weightUnit()) {
  const shown = inDisplayUnit(weightKg, unit);
  if (unit === LB) return String(shown);
  return String(Math.round(shown * 100) / 100);
}

// `82.4 kg · 3 days ago`. Null with no weigh-in: the head then draws nothing, not a dash.
export function readingLine(latest, now = Date.now(), unit = weightUnit()) {
  if (!latest) return null;
  const at = msOfDateLocal(latest.dateLocal);
  if (at == null) return null;
  return t('gym.bodyweight.reading', { weight: weightReading(latest.weightKg, unit), unit, ago: agoLabel(at, now) });
}

export function fieldValueOf(weightKg, unit = weightUnit()) {
  return weightReading(weightKg, unit);
}

export function chartDomainOf(weights, windowId) {
  const start = windowId === 'all' ? weights.entries[0]?.day ?? weights.today : weights.today.adding(1 - Bodyweight.recentDays);
  return { from: msOfDateLocal(start.text), to: msOfDateLocal(weights.today.text) };
}

// One dot per row, in the display unit, each carrying the words a reader or a screen reader gets.
export function chartPointsOf(entries, unit = weightUnit()) {
  return (entries ?? []).map((entry) => ({
    key: entry.dateLocal,
    at: msOfDateLocal(entry.dateLocal),
    value: inDisplayUnit(entry.weightKg, unit),
    label: t('gym.bodyweight.point', { weight: weightReading(entry.weightKg, unit), unit, day: shortDayLabel(msOfDateLocal(entry.dateLocal)) }),
    dateLocal: entry.dateLocal,
  })).filter((point) => point.at != null);
}

// `no weigh-in · 7 Jul – 4 Aug`: the last dot before the gap and the first after it.
export function gapLabel(from, to) {
  return t('gym.bodyweight.gap', { from: shortDayLabel(from.at), to: shortDayLabel(to.at) });
}

// `last 90 days · 3 weigh-ins`: the window the chart shows and how many dots are in it.
export function chartCaption(windowId, count) {
  return t('gym.bodyweight.caption', { window: windowId, count });
}

// The unit lives on the axis, in the display unit the dots are in.
export function axisValue(value, unit = weightUnit()) {
  return t('gym.bodyweight.axisValue', { value: Math.round(value * 10) / 10, unit });
}

export function axisDate(ms) {
  return shortDayLabel(ms);
}

// Save was refused: the store's sentence where it sent one, the failure's reason otherwise.
export function saveRefusal(error) {
  if (error?.sentence) return error.sentence;
  return t('gym.bodyweight.notSaved', { reason: failureReason(error) });
}

export const DELETE_FAILED = t('gym.bodyweight.deleteFailed');

// A delete this device could not store says so; any other failure is the brief's sentence.
export function deleteRefusal(error) {
  if (isStoreFailure(error)) return t('gym.bodyweight.notDeleted', { reason: failureReason(error) });
  return DELETE_FAILED;
}
