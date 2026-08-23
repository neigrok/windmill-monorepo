import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityLog, ActivityEvent } from './ActivityLog.js';

const FLASH_MS = 1400;
const PING_MS = 900;
const TICKER_MS = 4500;

export function useActivity({ sceneRef, selectedIdRef, selectedId, cancelNextUpSelect, setSelectedId }) {
  const [logVersion, setLogVersion] = useState(0);
  const [ticker, setTicker] = useState([]);
  const [newEventIds, setNewEventIds] = useState(() => new Set());
  const [feedOpen, setFeedOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activityPing, setActivityPing] = useState(false);

  const logRef = useRef(new ActivityLog());
  const unseenIdsRef = useRef(new Set());
  // Mirrors feedOpen || pinned for the synchronous checks a gesture makes.
  const feedSummonedRef = useRef(false);
  useEffect(() => { feedSummonedRef.current = feedOpen || pinned; }, [feedOpen, pinned]);

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

    // silent: the growth ceremony animates and summarizes these beats itself.
    if (!options.silent) {
      sceneRef.current?.pulseNode(event.nodeId);
      setTicker((prev) => [...prev, event].slice(-3));
      setTimeout(() => setTicker((prev) => prev.filter((entry) => entry.id !== event.id)), TICKER_MS);
    }
    return event;
  }, [sceneRef, selectedIdRef]);

  const seedActivity = useCallback(({ tree, states, completedAt, serverActivity }) => {
    const built = ActivityLog.fromTree(tree, states, completedAt).events;
    const fromServer = serverActivity.map((event) => new ActivityEvent({ ...event, actor: event.actor || null }));
    logRef.current = new ActivityLog([...built, ...fromServer]);
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

  const toggleActivity = useCallback(() => {
    const visibleAsFeed = feedSummonedRef.current && !selectedIdRef.current;
    if (visibleAsFeed) { closeActivity(); return; }
    setFeedOpen(true);
    setSelectedId(null);
  }, [closeActivity, selectedIdRef, setSelectedId]);

  // Auto-open summons the dock without deselecting.
  const openActivity = useCallback(() => setFeedOpen(true), []);
  const togglePin = useCallback(() => setPinned((value) => !value), []);

  const feedVisible = (feedOpen || pinned) && !selectedId;
  useEffect(() => { if (feedVisible) markRead(); }, [feedVisible, markRead]);

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
