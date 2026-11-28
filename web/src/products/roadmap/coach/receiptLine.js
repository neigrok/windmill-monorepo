// @ts-check
// D-4 A direct write's receipt as the conversation shows it (design, Receipts; packages/api-contract/roadmap/coach/receipts.json):
// one line of at most eight words that states what Coach wrote, made from the receipt's facts and never from the model's text.
// A name too long for the line is cut a word at a time, the part with the most words first and the later of two, never to
// nothing, an ellipsis where it was cut. A receipt whose write was undone reads Undone.

import { t } from '../i18n/index.js';

/** @typedef {{ ability: string, treeId: string, nodeId: string, label: string, change: 'completed' | 'reset' | 'changed' | 'created' | 'linked',
 *   fields?: string[], items?: string[], prerequisites?: string[] }} Receipt */

const MAX_WORDS = 8;

// The words a line counts: not its separators, nor a count of more.
/** @param {string} line */
const words = (line) => line.split(/\s+/u).filter((word) => word !== '' && word !== '·' && !word.startsWith('+'));

// A line with each named part cut, while the whole passes eight words.
/** @param {Record<string, string>} parts @param {(shown: Record<string, string>) => string} compose */
function cut(parts, compose) {
  const names = Object.keys(parts);
  const full = names.map((name) => parts[name]?.split(/\s+/u).filter((word) => word !== '') ?? []);
  const kept = full.map((part) => part.length);
  const line = () => compose(Object.fromEntries(names.map((name, index) => {
    const part = full[index] ?? [];
    const shown = part.slice(0, kept[index]).join(' ');
    return [name, (kept[index] ?? 0) < part.length ? `${shown}…` : shown];
  })));
  while (words(line()).length > MAX_WORDS) {
    const most = Math.max(...kept);
    if (most <= 1) break;
    kept[kept.lastIndexOf(most)] = most - 1;
  }
  return line();
}

/** @param {Receipt} receipt @param {'undone' | 'refused' | null} [fate] */
export function receiptLine(receipt, fate = null) {
  if (fate === 'undone') return t('roadmap.coach.receipt.undone');
  const step = receipt.label;
  const fields = receipt.fields ?? [];
  const items = receipt.items ?? [];
  const prerequisites = receipt.prerequisites ?? [];
  switch (receipt.change) {
    case 'completed': return cut({ step }, (shown) => t('roadmap.coach.receipt.completed', { step: shown.step }));
    case 'reset': return cut({ step }, (shown) => t('roadmap.coach.receipt.reset', { step: shown.step }));
    case 'linked': return cut({ step, prerequisite: prerequisites[0] ?? '' }, (shown) => t('roadmap.coach.receipt.linked', { step: shown.step, prerequisite: shown.prerequisite }));
    case 'created':
      if (prerequisites.length === 0) return cut({ step }, (shown) => t('roadmap.coach.receipt.created', { step: shown.step }));
      if (prerequisites.length === 1) return cut({ step, prerequisite: prerequisites[0] ?? '' }, (shown) => t('roadmap.coach.receipt.createdAfter', { step: shown.step, prerequisite: shown.prerequisite }));
      return cut({ step, prerequisite: prerequisites[0] ?? '' }, (shown) => t('roadmap.coach.receipt.createdAfterMore', { step: shown.step, prerequisite: shown.prerequisite, more: prerequisites.length - 1 }));
    case 'changed':
      if (fields.length === 0 && items.length === 1) return cut({ item: items[0] ?? '' }, (shown) => t('roadmap.coach.receipt.subtaskAdded', { item: shown.item }));
      if (fields.length === 0) return cut({ step }, (shown) => t('roadmap.coach.receipt.subtasksAdded', { step: shown.step, count: items.length }));
      if (fields.length === 1 && items.length === 0 && fields[0] === 'label') return cut({ step }, (shown) => t('roadmap.coach.receipt.renamed', { step: shown.step }));
      if (fields.length === 1 && items.length === 0 && fields[0] === 'description') return cut({ step }, (shown) => t('roadmap.coach.receipt.described', { step: shown.step }));
      if (fields.length === 1 && items.length === 0 && fields[0] === 'links') return cut({ step }, (shown) => t('roadmap.coach.receipt.linksChanged', { step: shown.step }));
      return cut({ step }, (shown) => t('roadmap.coach.receipt.changed', { step: shown.step }));
    default: return cut({ step }, (shown) => t('roadmap.coach.receipt.changed', { step: shown.step }));
  }
}
