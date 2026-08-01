// The roadmap landing lives at /roadmap but renders through the SPA, whose dist/index.html
// carries the BRAND ROOT's head — served as-is, crawlers would fold /roadmap into / as a
// duplicate (canonical points at the root). This postbuild step writes dist/roadmap/index.html:
// the same built shell (hashed asset URLs are absolute, so it boots from any path) with the
// head swapped to the roadmap landing's own title, description, canonical and social tags.
// Every swap asserts its source string exists exactly once, so a head edit in web/index.html
// that forgets this file fails the build instead of silently shipping a stale roadmap head.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');

function swap(from, to) {
  const first = html.indexOf(from);
  if (first === -1) throw new Error(`build-roadmap-shell: source string not found:\n  ${from}`);
  if (html.indexOf(from, first + 1) !== -1) throw new Error(`build-roadmap-shell: source string not unique:\n  ${from}`);
  html = html.slice(0, first) + to + html.slice(first + from.length);
}

swap(
  '<title>Windmill — Roadmap, Journal & Gym for self-growth</title>',
  '<title>Windmill Roadmap — any goal, as a skill tree</title>',
);
swap(
  'content="Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription."\n    />\n\n    <!-- Indexing controls',
  'content="Turn any goal or learning roadmap into an animated RPG skill tree. Finish a step, unlock the next branch. Free, no account — plant your first tree."\n    />\n\n    <!-- Indexing controls',
);
swap(
  '<link rel="canonical" href="https://windmill.works/" />',
  '<link rel="canonical" href="https://windmill.works/roadmap" />',
);
swap(
  '<meta property="og:url" content="https://windmill.works/" />',
  '<meta property="og:url" content="https://windmill.works/roadmap" />',
);
swap(
  '<meta property="og:title" content="Windmill — Grow, gently." />',
  '<meta property="og:title" content="Windmill — Any goal, as a skill tree" />',
);
swap(
  'property="og:description"\n      content="Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription."',
  'property="og:description"\n      content="Turn any plan — redecorating a room, learning to bake, training for a 10k, shipping a side project — into a living RPG skill tree. Finish a step, watch the next branch unlock. Public beta, no account needed."',
);
swap(
  '<meta name="twitter:title" content="Windmill — Grow, gently." />',
  '<meta name="twitter:title" content="Windmill — Any goal, as a skill tree" />',
);
swap(
  'name="twitter:description"\n      content="Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for what you’re noticing, a log for how you’re training. One account, one subscription."',
  'name="twitter:description"\n      content="Turn any plan into a living RPG skill tree. Finish a step, watch the next branch unlock. Public beta — no account needed, your first tree lives in your browser."',
);

mkdirSync(join(dist, 'roadmap'), { recursive: true });
writeFileSync(join(dist, 'roadmap', 'index.html'), html);
console.log('build-roadmap-shell: dist/roadmap/index.html written (8 head swaps asserted)');
