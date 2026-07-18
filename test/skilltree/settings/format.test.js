import test from 'node:test';
import assert from 'node:assert/strict';

import { formatUserAgent, relativeTime, shortDate, mcpKeyMeta } from '../../../src/skilltree/settings/format.js';

test('formatUserAgent — browser on OS for the common desktop agents', () => {
  assert.equal(
    formatUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    'Chrome on macOS',
  );
  assert.equal(
    formatUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'),
    'Safari on macOS',
  );
  assert.equal(
    formatUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    'Firefox on Windows',
  );
  assert.equal(
    formatUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'),
    'Edge on Windows',
  );
});

test('formatUserAgent — the mobile agents keep their OS distinct from macOS', () => {
  assert.equal(
    formatUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Safari on iOS',
  );
  assert.equal(
    formatUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'),
    'Chrome on Android',
  );
});

test('formatUserAgent — degrades gracefully with nothing to read', () => {
  assert.equal(formatUserAgent(''), 'Unknown device');
  assert.equal(formatUserAgent(null), 'Unknown device');
  assert.equal(formatUserAgent(undefined), 'Unknown device');
});

test('relativeTime — the near-now boundaries and the empty case', () => {
  const now = Date.now();
  assert.equal(relativeTime(0), '');
  assert.equal(relativeTime(now), 'just now');
  assert.equal(relativeTime(now - 5 * 60 * 1000), '5m ago');
  assert.equal(relativeTime(now - 3 * 60 * 60 * 1000), '3h ago');
  assert.equal(relativeTime(now - 2 * 24 * 60 * 60 * 1000), '2d ago');
});

test('shortDate — a fixed timestamp renders a plain date, empty for none', () => {
  assert.equal(shortDate(0), '');
  assert.equal(shortDate(Date.parse('2026-08-16T00:00:00Z')).includes('2026'), true);
});

test('mcpKeyMeta — a fresh key reads "never used" until its first call', () => {
  const created = Date.parse('2026-08-16T00:00:00Z');
  assert.equal(
    mcpKeyMeta({ createdMs: created, lastUsedMs: null }),
    `Created ${shortDate(created)} · never used`,
  );
});

test('mcpKeyMeta — a used key reports its last-active recency', () => {
  const created = Date.parse('2026-08-16T00:00:00Z');
  const usedAt = Date.now() - 3 * 60 * 60 * 1000;
  assert.equal(
    mcpKeyMeta({ createdMs: created, lastUsedMs: usedAt }),
    `Created ${shortDate(created)} · Last used 3h ago`,
  );
});
