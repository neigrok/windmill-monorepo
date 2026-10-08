// @ts-check

/** @typedef {{ containing(index: number): { index: number, segment: string } | undefined }} Graphemes */

// Compare NFC while returning whole-grapheme UTF-16 offsets in the untouched body.
/** @param {string | null | undefined} body @param {string | null | undefined} text @param {number | null | undefined} occurrenceHint @param {(text: string) => Graphemes} segment @returns {[number, number] | null} */
export function locateEcho(body, text, occurrenceHint, segment) {
  if (!body || !text) return null;
  const normalized = body.normalize('NFC');
  const quotation = text.normalize('NFC');
  const segments = segment(body);
  const canonicalSegments = body === normalized ? segments : segment(normalized);
  // NFC prefix lengths increase at grapheme boundaries; no scan through a long page is needed.
  /** @param {number} offset */
  const originalOffset = (offset) => {
    if (offset === 0) return 0;
    if (offset === normalized.length) return body.length;
    if (body === normalized) return offset;
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const boundary = segments.containing(mid)?.index ?? body.length;
      if (body.slice(0, boundary).normalize('NFC').length < offset) lo = mid + 1;
      else hi = mid;
    }
    return segments.containing(lo)?.index === lo
      && body.slice(0, lo).normalize('NFC').length === offset ? lo : undefined;
  };
  const want = Number.isInteger(occurrenceHint) && (occurrenceHint ?? -1) >= 0 ? occurrenceHint : 0;
  /** @type {[number, number] | null} */
  let first = null;
  let found = 0;
  let from = 0;
  while (from < normalized.length) {
    const at = normalized.indexOf(quotation, from);
    if (at < 0) return first;
    const end = at + quotation.length;
    if (canonicalSegments.containing(at)?.index !== at
      || (end < normalized.length && canonicalSegments.containing(end)?.index !== end)) {
      from = at + 1;
      continue;
    }
    const lo = originalOffset(at);
    const hi = originalOffset(end);
    if (lo === undefined || hi === undefined) { from = at + 1; continue; }
    const range = /** @type {[number, number]} */ ([lo, hi]);
    first ??= range;
    if (found === want) return range;
    found += 1;
    from = at + quotation.length;
  }
  return first;
}
