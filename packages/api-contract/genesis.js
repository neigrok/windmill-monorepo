// The genesis legend — the single source of truth shared by backend and web.
//
// A locally-born tree's first sync converges with the server's empty tree ONLY while this
// seed is byte-equal to the backend's Legend::seededDefaults + Hlc{1,0,"genesis"}. Keep this
// file and backend/products/roadmap/domain/Legend.cpp in lockstep; the web build asserts it.

export const GENESIS_STAMP = '1:0:genesis';

export const DEFAULT_KINDS = [
  { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
  { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
  { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
];

export const GENESIS_GOLDEN = JSON.stringify({ stamp: GENESIS_STAMP, kinds: DEFAULT_KINDS });
