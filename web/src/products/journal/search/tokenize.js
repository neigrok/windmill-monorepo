// Words carry vocabulary, trigrams carry morphology ("walk" ≈ "walking"). Function words are dropped.

const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have how i if in into is ' +
  'it its just me my no not of on or our so some than that the their them then there they this to too ' +
  'up was we were what when which who will with would you your'
).split(' '));

export function words(text) {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ? matches.filter((w) => w.length > 1) : [];
}

export function contentWords(text) {
  return words(text).filter((w) => !STOPWORDS.has(w));
}

export function trigrams(word) {
  if (word.length < 3) return [word];
  const grams = [];
  for (let i = 0; i + 3 <= word.length; i++) grams.push(word.slice(i, i + 3));
  return grams;
}

// [feature, weight] pairs — content words heavier, their trigrams lighter.
export function features(text) {
  const out = [];
  for (const word of contentWords(text)) {
    out.push([`w:${word}`, 1.0]);
    for (const gram of trigrams(word)) out.push([`t:${gram}`, 0.35]);
  }
  return out;
}
