// Must stay byte-equal to backend/products/roadmap/domain/Legend.cpp or a locally-born tree's first
// sync will not converge; the web build asserts it.

export const GENESIS_STAMP = '1:0:genesis';

export const DEFAULT_KINDS = [
  { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
  { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
  { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
];

export const GENESIS_GOLDEN = JSON.stringify({ stamp: GENESIS_STAMP, kinds: DEFAULT_KINDS });
