import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { syncSession as platformSync } from '../../../platform/sync/session.js';
import { registerRoomStatus } from '../../../shell/roomStatus.js';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { ANONYMOUS_OWNER, LAPSED_SESSION, SYNC_OFFLINE_SHORT, SYNC_STATUS } from '../copy.js';
import { refusalEventCode } from './refusals.js';
import { deriveSyncStatus, OFFLINE_GRACE_MS, SAVING_DELAY_MS, SAVED_HOLD_MS } from './status.js';

const OFFLINE_STATUS = Object.freeze({
  line: SYNC_STATUS.offline, short: SYNC_OFFLINE_SHORT, icon: 'offline', narrow: 'icon', connectivity: 'offline',
});

const SYNC_CLOCK = {
  now: () => Date.now(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (id) => clearTimeout(id),
};

export function useRoadmapSyncStatus(session, clock = SYNC_CLOCK) {
  const [reading, setReading] = useState(null);
  useEffect(() => {
    if (!session) return undefined;
    let timer;
    let previous = null;
    const facts = { lastLiveAt: clock.now(), pendingSince: null, drainedAt: null };
    const update = (snapshot) => {
      clock.clearTimeout(timer);
      const now = clock.now();
      const pending = snapshot.structurePending + snapshot.progressPending
        + snapshot.structureInFlight + snapshot.progressInFlight;
      if (snapshot.phase === 'live' || previous?.phase === 'live') facts.lastLiveAt = now;
      if (Boolean(snapshot.rebaselining) !== Boolean(previous?.rebaselining)) {
        facts.pendingSince = null;
        facts.drainedAt = null;
      }
      if (pending > 0 && facts.pendingSince === null) facts.pendingSince = now;
      if (pending === 0) {
        if (previous && facts.pendingSince !== null && snapshot.phase === 'live') facts.drainedAt = now;
        facts.pendingSince = null;
      }
      previous = snapshot;
      setReading({ session, snapshot, state: deriveSyncStatus(snapshot, now, facts) });
      const deadlines = [
        snapshot.phase !== 'live' ? facts.lastLiveAt + OFFLINE_GRACE_MS : null,
        facts.pendingSince === null ? null : facts.pendingSince + SAVING_DELAY_MS,
        facts.drainedAt === null ? null : facts.drainedAt + SAVED_HOLD_MS,
      ].filter((deadline) => deadline !== null && deadline > now);
      if (deadlines.length) {
        const nextDeadline = Math.min(...deadlines);
        timer = clock.setTimeout(() => update(session.statusSnapshot()), nextDeadline - now);
      }
    };
    const unsubscribe = session.subscribeStatus(update);
    return () => {
      unsubscribe();
      clock.clearTimeout(timer);
    };
  }, [session, clock]);
  if (reading?.session !== session) return { snapshot: null, state: null };
  return reading;
}

// What a room says about its saving: the device line, the refusal and the Shell's status slot, with the events each emits.
export function useRoomSyncNotices({ treeId, syncSession, owner, status, lapsed, phone, openSignInDoor, setBoardQuiet }) {
  const { snapshot: syncSnapshot, state: syncState } = useRoadmapSyncStatus(syncSession?.treeId === treeId ? syncSession : null);
  const deviceEligible = status === 'ghost' && owner && syncSession?.treeId === treeId;
  const deviceKind = deviceEligible ? (lapsed ? 'lapsed' : 'anonymous') : null;
  const deviceText = deviceKind === 'lapsed' ? LAPSED_SESSION : ANONYMOUS_OWNER;
  const signInFromDevice = useCallback(() => {
    if (!deviceKind) return;
    track('roadmap_device_line', { step: 'sign_in', line: deviceKind, place: 'row' });
    openSignInDoor();
  }, [deviceKind, openSignInDoor]);
  const deviceLine = useMemo(() => deviceKind ? { text: deviceText, onSignIn: signInFromDevice } : null,
    [deviceKind, deviceText, signInFromDevice]);
  const syncEligible = owner && status === 'signed-in' && !deviceLine;
  const refused = owner ? syncSnapshot?.refused : null;
  const refusalCode = refusalEventCode(refused);
  const refusedCount = refused?.lane === 'structure' ? syncSnapshot?.structureGestures : syncSnapshot?.progressGestures;
  const retrySync = useCallback(() => {
    if (!refused) return;
    track('roadmap_sync_refused', { step: 'retry', lane: refused.lane, code: refusalCode });
    syncSession.retry();
  }, [syncSession, refused, refusalCode]);
  const discardSync = useCallback(async () => {
    if (!refused) return;
    const discarded = syncSession.discard();
    if (syncSession.discardPending) setBoardQuiet((current) => current + 1);
    if (!await discarded) return;
    track('roadmap_sync_refused', { step: 'discard', lane: refused.lane, code: refusalCode });
  }, [syncSession, refused, refusalCode]);
  const refusal = useMemo(() => refused ? {
    code: refused.code,
    count: refusedCount,
    onRetry: retrySync,
    onDiscard: discardSync,
  } : null, [refused, refusedCount, retrySync, discardSync]);
  const syncReportsRef = useRef(null);
  useEffect(() => {
    if (!syncSession) return;
    if (syncReportsRef.current?.session !== syncSession) {
      syncReportsRef.current = { session: syncSession, shown: new Set() };
    }
    if (!refused) return;
    const reports = syncReportsRef.current;
    if (!reports.shown.has(refused.episode)) {
      reports.shown.add(refused.episode);
      track('roadmap_sync_refused', { step: 'shown', lane: refused.lane, code: refusalCode });
    }
  }, [syncSession, refused, refusalCode]);
  const deviceShownRef = useRef({ treeId, lines: new Set() });
  useEffect(() => {
    if (deviceShownRef.current.treeId !== treeId) deviceShownRef.current = { treeId, lines: new Set() };
    if (!deviceKind || deviceShownRef.current.lines.has(deviceKind)) return;
    deviceShownRef.current.lines.add(deviceKind);
    track('roadmap_device_line', { step: 'shown', line: deviceKind, place: phone ? 'row' : 'shell' });
  }, [treeId, deviceKind, phone]);
  const offlineRef = useRef({ shown: false, pending: '0' });
  useEffect(() => () => {
    if (offlineRef.current.shown) track('roadmap_sync_offline', { step: 'cleared', pending: offlineRef.current.pending });
    offlineRef.current = { shown: false, pending: '0' };
  }, [treeId, syncSession]);
  useEffect(() => {
    const offline = syncEligible && syncState === 'offline';
    const pending = countBucket((syncSnapshot?.structurePending ?? 0) + (syncSnapshot?.progressPending ?? 0));
    const changed = offlineRef.current.shown !== offline;
    offlineRef.current = { shown: offline, pending };
    if (changed) track('roadmap_sync_offline', { step: offline ? 'shown' : 'cleared', pending });
  }, [treeId, syncSession, syncEligible, syncState, syncSnapshot]);
  const roomStatusLease = useRef(null);
  const roomStatusEnabled = syncEligible || Boolean(deviceLine);
  useLayoutEffect(() => {
    if (!roomStatusEnabled) return undefined;
    const lease = registerRoomStatus();
    roomStatusLease.current = lease;
    return () => {
      roomStatusLease.current = null;
      lease.release();
    };
  }, [treeId, roomStatusEnabled]);
  // Offline lands in the same platform publish that would reveal the global notice, so React never commits that notice.
  useLayoutEffect(() => {
    if (!syncEligible || syncSession?.treeId !== treeId) return undefined;
    let online = platformSync.getSnapshot().online;
    return platformSync.subscribe(() => {
      const wasOnline = online;
      online = platformSync.getSnapshot().online;
      if (wasOnline && !online) roomStatusLease.current?.publish(OFFLINE_STATUS);
    });
  }, [treeId, syncSession, syncEligible]);
  useLayoutEffect(() => {
    const lease = roomStatusLease.current;
    if (!lease) return;
    if (deviceLine) {
      lease.publish(phone ? { narrow: 'device' } : { line: deviceLine.text });
      return;
    }
    if (!syncEligible || !syncState) {
      lease.publish(null);
      return;
    }
    const roomStatus = syncState === 'offline'
      ? OFFLINE_STATUS
      : { line: SYNC_STATUS[syncState], narrow: 'announce' };
    lease.publish(roomStatus);
  }, [treeId, roomStatusEnabled, deviceLine, phone, syncEligible, syncState]);

  return { syncSnapshot, deviceLine, refusal };
}
