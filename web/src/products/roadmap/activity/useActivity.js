import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityLog, ActivityEvent } from './ActivityLog.js';
import { t } from '../i18n/index.js';

const FLASH_MS = 1400;
const TICKER_MS = 4500;

export function useActivity({ sceneRef, selectedId }) {
  const [logVersion, setLogVersion] = useState(0);
  const [ticker, setTicker] = useState([]);
  const [newEventIds, setNewEventIds] = useState(() => new Set());
  const [feedOpen, setFeedOpen] = useState(false);

  const logRef = useRef(new ActivityLog());
  // Mirrors feedOpen for the synchronous checks a gesture makes.
  const feedSummonedRef = useRef(false);
  useEffect(() => { feedSummonedRef.current = feedOpen; }, [feedOpen]);

  const emit = useCallback((partial, options = {}) => {
    const event = new ActivityEvent({
      id: crypto.randomUUID?.() ?? `ev-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      actor: partial.actor ?? (partial.verb === 'unlocked' ? null : t('roadmap.activity.you')),
      verb: partial.verb,
      nodeId: partial.nodeId,
      label: partial.label,
      kind: partial.kind,
      at: Date.now(),
    });
    logRef.current.record(event);
    setLogVersion((version) => version + 1);

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
  }, [sceneRef]);

  const seedActivity = useCallback(({ tree, states, completedAt, serverActivity }) => {
    const built = ActivityLog.fromTree(tree, states, completedAt).events;
    const fromServer = serverActivity.map((event) => new ActivityEvent({ ...event, actor: event.actor || null }));
    logRef.current = new ActivityLog([...built, ...fromServer]);
    feedSummonedRef.current = false;
    setLogVersion((version) => version + 1);
    setTicker([]);
    setNewEventIds(new Set());
    setFeedOpen(false);
  }, []);

  const closeActivity = useCallback(() => setFeedOpen(false), []);
  const openActivity = useCallback(() => setFeedOpen(true), []);

  const feedVisible = feedOpen && !selectedId;

  const activityGroups = useMemo(() => logRef.current.groupedByDay(Date.now()), [logVersion]);
  const selectedHistory = useMemo(() => (selectedId ? logRef.current.forNode(selectedId) : []), [selectedId, logVersion]);

  return {
    emit,
    seedActivity,
    ticker,
    newEventIds,
    feedVisible,
    feedSummonedRef,
    activityGroups,
    selectedHistory,
    eventCount: logRef.current.size,
    openActivity,
    closeActivity,
  };
}
