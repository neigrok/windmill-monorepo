// The strip records eleven, every read-only glyph reads five (mood) or three (energy). One rule for
// the day pip, the week square and the year cell, so the glyphs never drift from each other. The five
// mood bands sit on the odd tokens 1/3/5/7/9 — the five shipped anchors — so no glyph changes colour.

export function moodBand(score) {
  if (score == null) return null;
  if (score <= 1) return 1;
  if (score <= 3) return 3;
  if (score <= 6) return 5;
  if (score <= 8) return 7;
  return 9;
}

export function energyBars(score) {
  if (score == null) return 0;
  if (score <= 3) return 0;
  if (score <= 6) return 1;
  if (score <= 8) return 2;
  return 3;
}
