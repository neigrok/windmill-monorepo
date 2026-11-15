// A take Talk was refused, held in this tab's memory until it is written down, downloaded or discarded. Nothing keeps it
// past a reload: the download is the way to keep it.

import { captureError } from '../../../telemetry/sentry.js';

// The waveform's bars, as the sheet draws them.
export const BARS = 25;

export class Take {
  // `audio` is the recorder's Blob, `levels` its loudness in BARS steps (levelsOf), `recordedAt` when it began.
  constructor({ audio, durationMs, recordedAt, levels }) {
    this.audio = audio;
    this.durationMs = durationMs;
    this.recordedAt = recordedAt;
    this.levels = levels;
    this.url = URL.createObjectURL(audio);
  }

  // 1:42 — minutes and seconds.
  get length() {
    const seconds = Math.round(this.durationMs / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  // talk-2026-12-03-0914.webm: when it began, in this browser's zone, in the recorder's own format.
  get filename() {
    const at = new Date(this.recordedAt);
    const two = (value) => String(value).padStart(2, '0');
    const format = /^audio\/([a-z0-9]+)/i.exec(this.audio.type)?.[1].toLowerCase() ?? 'webm';
    return `talk-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}.${format}`;
  }

  release() {
    URL.revokeObjectURL(this.url);
  }
}

// The take's loudness in BARS steps, each its root mean square over the loudest step's, from 0 to 1. A browser that
// cannot decode its own recording gets a flat line, and Sentry hears of it.
export async function levelsOf(audio) {
  try {
    const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await audio.arrayBuffer());
    const samples = decoded.getChannelData(0);
    const step = samples.length / BARS;
    const energy = Array.from({ length: BARS }, (_, bar) => {
      const span = samples.subarray(Math.floor(bar * step), Math.floor((bar + 1) * step));
      return span.length ? Math.sqrt(span.reduce((sum, sample) => sum + sample * sample, 0) / span.length) : 0;
    });
    const loudest = Math.max(...energy);
    return loudest > 0 ? energy.map((value) => value / loudest) : energy;
  } catch {
    captureError('journal', 'journal-talk-levels', '', '/journal');
    return Array(BARS).fill(0);
  }
}
