import test from 'node:test';
import assert from 'node:assert/strict';

import { Take } from '../../../../src/products/journal/talk/take.js';

process.env.TZ = 'UTC';

test('a kept take downloads under the moment it began, in the recorder’s own format, and shows its length', () => {
  const recordedAt = Date.UTC(2026, 11, 3, 9, 4);
  const takes = [
    [new Blob(['a'], { type: 'audio/webm;codecs=opus' }), 102_400],
    [new Blob(['a'], { type: 'audio/mp4' }), 59_600],
    [new Blob(['a'], { type: 'audio/ogg; codecs=opus' }), 3_600_000],
    [new Blob(['a']), 400],
  ];

  const shown = takes.map(([audio, durationMs]) => {
    const take = new Take({ audio, durationMs, recordedAt, levels: [] });
    take.release();
    return [take.filename, take.length];
  });

  assert.deepEqual(shown, [
    ['talk-2026-12-03-0904.webm', '1:42'],
    ['talk-2026-12-03-0904.mp4', '1:00'],
    ['talk-2026-12-03-0904.ogg', '60:00'],
    ['talk-2026-12-03-0904.webm', '0:00'],
  ]);
});
