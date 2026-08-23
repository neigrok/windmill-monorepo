// Manual gate (npm run test:model), not part of the CI `node --test` run.

import { pipeline, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const FLOOR = 0.45;

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' });
const embed = async (text) => (await extractor(text, { pooling: 'mean', normalize: true })).data;
const cosine = (a, b) => { let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; return dot; };

const query = await embed(QUERY_PREFIX + 'I felt anxious and behind');
const related = [
  'Kept comparing and it did not help.',
  'Everyone else seems further along than me.',
];
const unrelated = [
  'Rain all morning, so the walk did not happen.',
  'Long walk with no podcast in the quiet.',
];

const scoreOf = async (line) => cosine(query, await embed(line));
const relatedScores = await Promise.all(related.map(scoreOf));
const unrelatedScores = await Promise.all(unrelated.map(scoreOf));
const worstRelated = Math.min(...relatedScores);
const bestUnrelated = Math.max(...unrelatedScores);

console.log('query: "I felt anxious and behind"  (self-hosted, remote disabled)');
related.forEach((line, i) => console.log(`  ${relatedScores[i].toFixed(3)}  related    "${line}"`));
unrelated.forEach((line, i) => console.log(`  ${unrelatedScores[i].toFixed(3)}  unrelated  "${line}"`));
console.log(`\nworst related ${worstRelated.toFixed(3)} · best unrelated ${bestUnrelated.toFixed(3)} · floor ${FLOOR}`);

if (!(worstRelated > FLOOR && bestUnrelated < FLOOR && worstRelated - bestUnrelated > 0.08)) {
  console.error('FAIL: meaning-match margin collapsed — related must clear the floor, unrelated must not.');
  process.exit(1);
}
console.log('OK: meaning-match separation holds.');
