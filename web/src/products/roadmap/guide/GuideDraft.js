// A tree's guide as the people who write it meet it: plain text, at most 5,000 code points counted as the server counts
// them, and an empty guide is no guide. A draft is the text being written against the guide it started from.

export const GUIDE_BOUND = 5000;
const COUNTER_FROM = 4500;
// A surrogate pair, a lone surrogate or a NUL: what a paste can carry and a guide's row cannot hold.
const UNHELD = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|\u0000/g;

// A guide the server would refuse reaching a door that writes without asking it: a defect, never a person's text.
export class InadmissibleGuide extends Error {
  constructor() {
    super('Guide not admissible');
    this.name = 'InadmissibleGuide';
  }
}

// A guide as a field holds it: one line feed for every line ending, so an offset in the text read is the field's caret.
export function withLineFeeds(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function hasGuide(text) {
  return /\S/.test(text ?? '');
}

// The server's admission: well-formed text without a NUL, at most 5,000 code points, and words or nothing at all.
export function admitsGuide(text) {
  if (typeof text !== 'string') return false;
  if (text !== heldText(text) || [...text].length > GUIDE_BOUND) return false;
  return text === '' || hasGuide(text);
}

// The first line with words on it, as the guide's card on the tree shows it and its control's name says it.
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

const WORTH_TRYING_AGAIN = new Set([408, 429]);

// Why a save no door took failed, as its event carries it and the note's line says it. Offline is the browser's word:
// the request never arrived and `online`, what navigator.onLine reports, is false; a request lost while online is the
// server's failure. Refused is a 4xx that trying again cannot change, or text a door would not admit. The rest is the
// door that failed: the server, else this device's store or session.
export function saveFailureReason(error, door, online) {
  if (error?.status === 0) return online ? 'server' : 'offline';
  if (error instanceof InadmissibleGuide) return 'refused';
  if (error?.status >= 400 && error.status < 500 && !WORTH_TRYING_AGAIN.has(error.status)) return 'refused';
  return door === 'server' ? 'server' : 'device';
}

export class GuideDraft {
  constructor(base, text = base) {
    this.base = withLineFeeds(base);
    this.text = withLineFeeds(text);
    this.held = heldText(text);
    this.length = [...this.held].length;  // a string's iterator walks code points, as the server counts: 🌊 is one, not two UTF-16 units
    Object.freeze(this);
  }

  writing(text) {
    return new GuideDraft(this.base, text);
  }

  // Blank against no guide is no change: Save would write nothing, and there is nothing to discard.
  get changed() { return this.text !== this.base && (hasGuide(this.text) || hasGuide(this.base)); }
  get fits() { return this.length <= GUIDE_BOUND; }
  get counted() { return this.length >= COUNTER_FROM; }
  get left() { return Math.max(0, GUIDE_BOUND - this.length); }
  get over() { return Math.max(0, this.length - GUIDE_BOUND); }

  // What Save writes: the text as it shows, or nothing when it holds no words.
  get saved() { return hasGuide(this.held) ? this.held : ''; }

  // The guide moved away from the one this draft started from: someone else saved, and Save would replace that version.
  outdatedBy(guide) { return withLineFeeds(guide) !== this.base; }
}

// The text as it shows, which is what a guide can hold: the replacement glyph a browser draws for a lone surrogate takes its
// place, as String.prototype.toWellFormed() puts it, and a NUL, which draws nothing, goes.
function heldText(text) {
  return text.replace(UNHELD, (unit) => {
    if (unit.length === 2) return unit;
    return unit === '\u0000' ? '' : '\uFFFD';
  });
}
