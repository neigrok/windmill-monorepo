// The nudge settings, and the device's half of the bargain. Reading is a plain GET; the interesting
// move is `enable`, which computes the next knock from the writer's own rhythm (rhythm.js, over the
// page history it fetches once) and sends only that instant + its day — the server stores a schedule
// it never derives. `armed` rides along from the server: the dark-launch gate, kept apart from the
// caller's own on/off, and the reason the whole control stays hidden until the engine can actually reach
// this writer. Every action returns the fresh settings, so the panel always shows the truth.

import { useCallback, useEffect, useState } from 'react';
import { journalApi } from './journalApi.js';
import { nextNudge } from './rhythm.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function useNudge() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    journalApi.nudge()
      .then((next) => { if (!cancelled) { setSettings(next); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const apply = useCallback(async (patch) => {
    const next = await journalApi.patchNudge(patch);
    setSettings(next);
  }, []);

  const enable = useCallback(async () => {
    const pages = await journalApi.since('0:0:', 5000).catch(() => []);
    const { nextDueAt, slotDay } = nextNudge(pages, Date.now());
    await apply({ enabled: true, nextDueAt, slotDay });
  }, [apply]);

  const disable = useCallback(() => apply({ enabled: false }), [apply]);
  const setChannel = useCallback((channel) => apply({ channel }), [apply]);
  const snooze = useCallback(() => apply({ pausedUntil: Date.now() + WEEK_MS }), [apply]);

  return { settings, loading, armed: !!settings?.armed, enable, disable, setChannel, snooze };
}
