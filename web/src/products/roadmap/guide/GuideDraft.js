// A tree's guide as the people who write it meet it: plain text, at most 5,000 code points counted as the server counts
// them, and an empty guide is no guide. A draft is the text being written against the guide it started from.

export const GUIDE_BOUND = 5000;
const COUNTER_FROM = 4500;

export function hasGuide(text) {
  return /\S/.test(text ?? '');
}

// The first line with words on it, as the row's chip and the reader's line show it.
export function guideExcerpt(text) {
  return (text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

// A guide's length as an event may carry it: a bounded label, never the count.
export function guideLengthBucket(length) {
  if (length < 1) return '0';
  if (length <= 500) return '1-500';
  if (length <= 2000) return '501-2000';
  if (length <= COUNTER_FROM) return '2001-4500';
  return '4501-5000';
}

export class GuideDraft {
  constructor(base, text = base) {
    this.base = base;
    this.text = text;
    this.length = [...text].length;  // a string's iterator walks code points, as the server counts: 🌊 is one, not two UTF-16 units
    Object.freeze(this);
  }

  writing(text) {
    return new GuideDraft(this.base, text);
  }

  get changed() { return this.text !== this.base; }
  get fits() { return this.length <= GUIDE_BOUND; }
  get counted() { return this.length >= COUNTER_FROM; }
  get left() { return Math.max(0, GUIDE_BOUND - this.length); }
  get over() { return Math.max(0, this.length - GUIDE_BOUND); }

  // What Save writes: the text as written, or nothing when it holds no words.
  get saved() { return hasGuide(this.text) ? this.text : ''; }

  // The guide moved away from the one this draft started from: someone else saved, and Save would replace that version.
  outdatedBy(guide) { return guide !== this.base; }
}
