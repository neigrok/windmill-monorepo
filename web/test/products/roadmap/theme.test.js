import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND, BARK, BARK_CREAM, CHIP, CONNECTOR, NODE_COLORS, NODE_COLOR_NAMES, sceneTheme } from '../../../src/products/roadmap/theme.js';

test('light scene theme is the module constants, byte for byte', () => {
  const light = sceneTheme(false);
  assert.equal(light.BACKGROUND, BACKGROUND);
  assert.deepEqual(light.CONNECTOR, { inactive: CONNECTOR.inactive, active: '#B29F7B' });
  assert.equal(light.BARK, BARK);
  assert.equal(light.BARK_CREAM, BARK_CREAM);
  assert.equal(light.NODE_COLORS, NODE_COLORS);
  assert.equal(light.CHIP, CHIP);
  assert.deepEqual(light.BACKGROUND, { canvas: '#F9F5EB', glow: '#F3F4E4' });
  assert.equal(CONNECTOR.inactive, '#D3C2A0');
  assert.equal(BARK, '#9C6B44');
  assert.equal(BARK_CREAM, '#EAD8B0');
  assert.deepEqual(NODE_COLORS.terracotta, { base: '#BC6C42', ring: '#9D5330', soft: '#EAC6B0', glow: 'rgba(188,108,66,0.50)' });
});

test('night scene theme carries the roadmap night contract', () => {
  const night = sceneTheme(true);
  assert.deepEqual(night.BACKGROUND, { canvas: '#0B0B0C', glow: '#141416' });
  assert.deepEqual(night.CONNECTOR, { inactive: '#2E2E32', active: '#7E7C77' });
  assert.equal(night.BARK, '#6E5D49');
  assert.equal(night.BARK_CREAM, '#D9C7A6');
  assert.deepEqual(night.CHIP, { bg: '#F2F0EB', ink: '#0B0B0C' });
  assert.deepEqual(Object.keys(night.NODE_COLORS), NODE_COLOR_NAMES);
  const baseRing = Object.fromEntries(NODE_COLOR_NAMES.map((k) => [k, [night.NODE_COLORS[k].base, night.NODE_COLORS[k].ring, night.NODE_COLORS[k].soft]]));
  assert.deepEqual(baseRing, {
    terracotta: ['#D98B5F', '#E2A887', '#30221B'],
    olive:      ['#9DAF5C', '#B6C385', '#25291A'],
    gold:       ['#D9AE45', '#E2C274', '#302816'],
    brick:      ['#C86B50', '#D6907C', '#2D1C18'],
    sky:        ['#7BA6B8', '#9CBCCA', '#1F272B'],
    plum:       ['#B06FA6', '#C493BC', '#291D28'],
  });
  assert.equal(night.NODE_COLORS.terracotta.glow, 'rgba(221,151,111,0.50)');
});

test('the same object comes back for the same room, so a scene can skip a no-op re-resolve', () => {
  assert.equal(sceneTheme(true), sceneTheme(true));
  assert.equal(sceneTheme(false), sceneTheme(false));
  assert.notEqual(sceneTheme(true), sceneTheme(false));
});
