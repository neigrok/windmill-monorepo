// `enable` computes the next knock from the writer's own rhythm (rhythm.js) and sends only that instant
// plus its day; the server stores a schedule it never derives. `armed` comes from the server and is kept
// apart from the caller's own on/off.

import { useCallback, useEffect, useState } from 'react';
import { journalApi } from './journalApi.js';
import { nextNudge } from './rhythm.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function useNudge(account = null) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  // Re-read whenever the signed-in account changes: these are one account's schedule and mailbox.
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

  // The account's pages and nothing else: the rhythm reads each page's last-write instant, and a page
  // held on the device carries no `updatedAt`.
  const enable = useCallback(async () => {
    const pages = await journalApi.allPages().catch(() => []);
    const { nextDueAt, slotDay } = nextNudge(pages, Date.now());
    await apply({ enabled: true, nextDueAt, slotDay });
  }, [apply]);

  const disable = useCallback(() => apply({ enabled: false }), [apply]);
  const setChannel = useCallback((channel) => apply({ channel }), [apply]);
  const snooze = useCallback(() => apply({ pausedUntil: Date.now() + WEEK_MS }), [apply]);

  // `suppressed` sits beside `armed`, not beside `enabled`: both are facts about reaching this writer.
  return { settings, loading, armed: !!settings?.armed, suppressed: !!settings?.suppressed,
           enable, disable, setChannel, snooze };
}
