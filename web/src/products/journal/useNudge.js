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

export function useNudge(account = null) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  // Re-read whenever the signed-in account changes: these settings are one account's schedule and
  // one account's mailbox, and a panel still showing the previous person's is the device-residue
  // class of JOURNAL-1 said in a smaller room.
  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setLoading(true);
    journalApi.nudge()
      .then((next) => { if (!cancelled) { setSettings(next); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account]);

  const apply = useCallback(async (patch) => {
    const next = await journalApi.patchNudge(patch);
    setSettings(next);
  }, []);

  // The account's pages and nothing else, deliberately — this is the one corpus reader that does
  // NOT join the device's (pageStore.js `corpus`). The rhythm is read from each page's last-write
  // INSTANT, and a page held on the device carries a day and a stamp but no `updatedAt`, so it
  // could contribute a page to the histogram and never an hour. Nor is there a signed-out case to
  // serve: the whole panel only exists when the server says the engine is armed for this writer.
  const enable = useCallback(async () => {
    const pages = await journalApi.allPages().catch(() => []);
    const { nextDueAt, slotDay } = nextNudge(pages, Date.now());
    await apply({ enabled: true, nextDueAt, slotDay });
  }, [apply]);

  const disable = useCallback(() => apply({ enabled: false }), [apply]);
  const setChannel = useCallback((channel) => apply({ channel }), [apply]);
  const snooze = useCallback(() => apply({ pausedUntil: Date.now() + WEEK_MS }), [apply]);

  // `suppressed` sits beside `armed` and not beside `enabled` on purpose: both are OUR facts about
  // reaching this writer — the gate, and a mailbox the provider called dead — never the writer's
  // own preference, which `enabled` alone carries.
  return { settings, loading, armed: !!settings?.armed, suppressed: !!settings?.suppressed,
           enable, disable, setChannel, snooze };
}
