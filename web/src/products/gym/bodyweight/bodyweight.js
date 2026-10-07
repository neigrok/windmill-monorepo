import { Bodyweight } from '../domain/bodyweight.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { failureReason, isStoreFailure } from '../errors.js';
import { agoLabel, shortDayLabel } from '../log.js';
import { inDisplayUnit, LB, weightUnit } from '../units.js';

export const BODYWEIGHT_TITLE = 'Bodyweight';
export const WEIGH_IN_VERB = 'Weigh in';
export const DATE_LABEL = 'Date';
export const SAVE_VERB = 'Save';
export const NO_WEIGH_INS = 'No weigh-ins yet.';
export const NO_WEIGH_INS_LINE = 'Weigh in from the log and the number lands here.';
export const NO_WEIGH_INS_IN_WINDOW = 'No weigh-in in the last 90 days.';
export const OPENING = 'Opening your weigh-ins…';
export const FAILED = 'Your weigh-ins didn’t load.';

export const DELETE_VERB = 'Delete weigh-in';

// One press, and the way back is the window's Undo rather than a question in front of the act.
export const WEIGH_IN_DELETED = 'Weigh-in deleted.';

export const REFUSALS = {
  notNumber: 'That is not a number yet.',
  decimals: 'One decimal point only.',
  bounds: 'Between 20 and 400 kg — check the number.',
  future: 'A weigh-in is not a forecast — today or earlier.',
};

// `label` is the control's word; `stated` is how the chart prints the window it shows.
export const WINDOWS = [
  { id: '90', label: '90 days', stated: 'last 90 days' },
  { id: 'all', label: 'All', stated: 'the whole series' },
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
  return `${weightReading(latest.weightKg, unit)} ${unit} · ${agoLabel(at, now)}`;
}

export function fieldValueOf(weightKg, unit = weightUnit()) {
  return weightReading(weightKg, unit);
}

export function windowById(id) {
  return WINDOWS.find((window) => window.id === id) ?? WINDOWS[0];
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
    label: `${weightReading(entry.weightKg, unit)} ${unit} · ${shortDayLabel(msOfDateLocal(entry.dateLocal))}`,
    dateLocal: entry.dateLocal,
  })).filter((point) => point.at != null);
}

// `no weigh-in · 7 Jul – 4 Aug`: the last dot before the gap and the first after it.
export function gapLabel(from, to) {
  return `no weigh-in · ${shortDayLabel(from.at)} – ${shortDayLabel(to.at)}`;
}

// `last 90 days · 3 weigh-ins`: the window the chart shows and how many dots are in it.
export function chartCaption(windowId, count) {
  const counted = count === 1 ? '1 weigh-in' : `${count} weigh-ins`;
  return `${windowById(windowId).stated} · ${counted}`;
}

// The unit lives on the axis, in the display unit the dots are in.
export function axisValue(value, unit = weightUnit()) {
  return `${Math.round(value * 10) / 10} ${unit}`;
}

export function axisDate(ms) {
  return shortDayLabel(ms);
}

// Save was refused: the store's sentence where it sent one, the failure's reason otherwise.
export function saveRefusal(error) {
  if (error?.sentence) return error.sentence;
  return `That weigh-in wasn’t saved — ${failureReason(error)}.`;
}

export const DELETE_FAILED = 'That weigh-in wasn’t deleted. Try again in a moment.';

// A delete this device could not store says so; any other failure is the brief's sentence.
export function deleteRefusal(error) {
  if (isStoreFailure(error)) return `That weigh-in wasn’t deleted — ${failureReason(error)}.`;
  return DELETE_FAILED;
}
