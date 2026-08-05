// The activity feed's controller, over the mutable ActivityLog: what has happened to this tree,
// how each arrival is felt, and whether the dock is showing it. One verb records — `emit` — and
// everything the feed shows falls out of that: the grouped rows, a step's own history, the unread
// badge, the chip's ping, the arrival flash and the ticker.
//
// Closed ≠ deaf (design A″). The feed is closed by default, so an arrival that lands while nobody
// is watching still counts: it joins the unseen set, bumps the badge and pings the chip, and
// flashes when the feed is finally opened. "Watching" is the feed being the dock's visible tenant
// — summoned or pinned, AND no step selected — which is why one ref mirrors that whole condition
// for the synchronous checks a gesture makes.
//
// The log itself is mutable and lives in a ref, so a version counter is what re-renders off it.
// The scene is reached for exactly one thing: an arrival pulses its node before any words appear.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityLog, ActivityEvent } from './ActivityLog.js';

const FLASH_MS = 1400;   // how long a fresh row wears its arrival flash
const PING_MS = 900;     // the chip's transient pulse on an unwatched arrival
const TICKER_MS = 4500;  // a ticker toast's life; at most three stand at once

export function useActivity({ sceneRef, selectedIdRef, selectedId, cancelNextUpSelect, setSelectedId }) {
  const [logVersion, setLogVersion] = useState(0); // bump to re-render off the mutable activity log
  const [ticker, setTicker] = useState([]); // live arrival toasts (design C), max 3
  const [newEventIds, setNewEventIds] = useState(() => new Set()); // rows flashing on arrival
  const [feedOpen, setFeedOpen] = useState(false); // the activity feed is summoned (design A″ — closed by default)
  const [pinned, setPinned] = useState(false); // …or pinned to stay docked (= option A)
  const [unreadCount, setUnreadCount] = useState(0); // events since the feed was last opened
  const [activityPing, setActivityPing] = useState(false); // transient chip pulse on a fresh arrival

  const logRef = useRef(new ActivityLog());
  const unseenIdsRef = useRef(new Set()); // events that arrived while the feed wasn't visible
  // Mirrors "the feed is summoned or pinned" for the synchronous checks a gesture makes — a
  // canvas tap, Escape, the auto-open's fire-time re-check — none of which can wait for a render.
  const feedSummonedRef = useRef(false);
  useEffect(() => { feedSummonedRef.current = feedOpen || pinned; }, [feedOpen, pinned]);

  // Record one activity event and play its arrival: the node pulses on the graph
  // (felt first), a ticker toast announces it, and the fresh row flashes in the
  // feed. Removed events skip the pulse/toast — the node is gone and the delete's
  // Undo toast already speaks. Unlocks belong to the tree, so they carry no actor.
  const emit = useCallback((partial, options = {}) => {
    const event = new ActivityEvent({
      id: crypto.randomUUID?.() ?? `ev-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      actor: partial.actor ?? (partial.verb === 'unlocked' ? null : 'You'),
      verb: partial.verb,
      nodeId: partial.nodeId,
      label: partial.label,
      kind: partial.kind,
      at: Date.now(),
    });
    logRef.current.record(event);
    setLogVersion((version) => version + 1);

    // Closed ≠ deaf (design A″): an arrival that lands while the feed isn't being
    // watched counts toward the unread badge and pings the chip; it'll flash on open.
    const watching = feedSummonedRef.current && !selectedIdRef.current;
    if (!watching) {
      unseenIdsRef.current.add(event.id);
      setUnreadCount(unseenIdsRef.current.size);
      setActivityPing(true);
      setTimeout(() => setActivityPing(false), PING_MS);
    }

    if (event.verb === 'removed') return event;

    setNewEventIds((prev) => new Set(prev).add(event.id));
    setTimeout(() => setNewEventIds((prev) => { const next = new Set(prev); next.delete(event.id); return next; }), FLASH_MS);

    // A ceremony's completed/unlocked beats are the growth ceremony's to animate and
    // summarize: they don't pulse individually here, nor stack the ticker. Other
    // verbs (added / renamed / started) still feel their arrival pulse + ticker.
    if (!options.silent) {
      sceneRef.current?.pulseNode(event.nodeId);
      setTicker((prev) => [...prev, event].slice(-3));
      setTimeout(() => setTicker((prev) => prev.filter((entry) => entry.id !== event.id)), TICKER_MS);
    }
    return event;
  }, [sceneRef, selectedIdRef]);

  // A freshly-loaded tree brings its own history: the roadmap's build story (the completed deeds)
  // folded together with the server's structural op log, oldest-first. Everything the feed was
  // showing about the tree being left behind goes with it — including the unread badge, which
  // belongs to that tree's arrivals and not to this one's.
  const seedActivity = useCallback(({ tree, states, serverActivity }) => {
    const built = ActivityLog.fromTree(tree, states, Date.now()).events;
    const fromServer = serverActivity.map((event) => new ActivityEvent({ ...event, actor: event.actor || null }));
    logRef.current = new ActivityLog([...built, ...fromServer].sort((a, b) => a.at - b.at));
    unseenIdsRef.current = new Set();
    feedSummonedRef.current = false;
    setLogVersion((version) => version + 1);
    setTicker([]);
    setNewEventIds(new Set());
    setFeedOpen(false);
    setPinned(false);
    setUnreadCount(0);
    setActivityPing(false);
  }, []);

  // The feed became visible: clear the unread badge and replay the events that
  // arrived while it was closed with the arrival flash (design A″ — E's catch-up).
  const markRead = useCallback(() => {
    const ids = [...unseenIdsRef.current];
    if (ids.length === 0) return;
    unseenIdsRef.current = new Set();
    setUnreadCount(0);
    setActivityPing(false);
    setNewEventIds((prev) => new Set([...prev, ...ids]));
    setTimeout(() => setNewEventIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; }), FLASH_MS);
  }, []);

  const closeActivity = useCallback(() => {
    cancelNextUpSelect();
    setFeedOpen(false);
    setPinned(false);
  }, [cancelNextUpSelect]);

  // The Activity chip / the `a` key: summon the feed, or dismiss it if it's the
  // visible tenant. Opening deselects so the feed (not a step's details) shows.
  const toggleActivity = useCallback(() => {
    const visibleAsFeed = feedSummonedRef.current && !selectedIdRef.current;
    if (visibleAsFeed) { closeActivity(); return; }
    setFeedOpen(true);
    setSelectedId(null);
  }, [closeActivity, selectedIdRef, setSelectedId]);

  // The return visit's auto-open (whats-next-panel §04) summons the dock without deselecting —
  // it only ever fires with nothing selected, and it must not move focus.
  const openActivity = useCallback(() => setFeedOpen(true), []);
  const togglePin = useCallback(() => setPinned((value) => !value), []);

  // The feed is the visible dock tenant when summoned/pinned and no step is
  // selected. Whenever it becomes visible, mark everything read (with a catch-up flash).
  const feedVisible = (feedOpen || pinned) && !selectedId;
  useEffect(() => { if (feedVisible) markRead(); }, [feedVisible, markRead]);

  // The grouped view and per-node history both recompute when the log version bumps.
  const activityGroups = useMemo(() => logRef.current.groupedByDay(Date.now()), [logVersion]);
  const selectedHistory = useMemo(() => (selectedId ? logRef.current.forNode(selectedId) : []), [selectedId, logVersion]);

  return {
    emit,
    seedActivity,
    ticker,
    newEventIds,
    pinned,
    unreadCount,
    activityPing,
    feedVisible,
    feedSummonedRef,
    activityGroups,
    selectedHistory,
    eventCount: logRef.current.size,
    toggleActivity,
    openActivity,
    closeActivity,
    togglePin,
  };
}
