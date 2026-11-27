// The newest roadmap as the home card offers it back: the person's roadmaps it is the first of, its name, a short name for
// a button, how long ago it was tended, and the sentence that says so around a progress figure.

import { useEffect, useState } from 'react';
import { t } from './i18n/app/index.js';
import { listTrees } from './persistence/TreeRegistry.js';
import { ROOM_READS_REPLICA } from './replicaRoom.js';

// How long ago a roadmap was last changed; null when it can't tell.
function tendedAgo(updatedAt) {
  if (updatedAt == null) return null;
  const then = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return t('roadmap.ago.justNow');
  if (mins < 60) return t('roadmap.ago.minutes', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('roadmap.ago.hours', { count: hrs });
  const days = Math.round(hrs / 24);
  if (days < 7) return t('roadmap.ago.days', { count: days });
  return t('roadmap.ago.weeks', { count: Math.round(days / 7) });
}

export function resumeOf(tree) {
  const name = tree.title?.trim() || t('roadmap.common.untitled');
  const chars = Array.from(name); // cut by code points — an emoji never splits
  return { name, shortName: chars.length > 18 ? `${chars.slice(0, 17).join('').trimEnd()}…` : name, tended: tendedAgo(tree.updatedAt) };
}

export function resumeSummary({ name, tended }, progress) {
  return tended ? t('roadmap.resume.summaryTended', { name, progress, tended }) : t('roadmap.resume.summary', { name, progress });
}

// The person's roadmaps, newest first, from where this build's room reads them: where it reads the device's copy
// (replicaRoom.js), the copy's list once the device can say what each roadmap is, signed in or out, and again as it
// changes; elsewhere the server's list (`GET /v1/trees`), read once while `signedIn`. `list` is null until the first
// answer and while the copy's list is unread, so a surface keeps what it held; `waiting` says that answer is still due:
// the server's list while it is asked, and the copy's until it is listed, or the copy did not open within the bound,
// or could not open at all. A copy that opens after its bound is listed then. The copy's reading loads with its first use, so
// neither surface carries the room's modules where the switch is off.
export function useYourRoadmaps(signedIn) {
  const [list, setList] = useState(null);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (ROOM_READS_REPLICA) {
      const wanted = new AbortController();
      let reading = null;
      setUnread(false);
      import('./room/ReplicaReading.js').then(({ ReplicaReading }) => {
        if (wanted.signal.aborted) return undefined;
        reading = new ReplicaReading({ treeId: null });
        return reading.followRoadmaps({ signal: wanted.signal, onList: setList, onUnread: () => setUnread(true) });
      }).catch(() => { if (!wanted.signal.aborted) setUnread(true); });
      return () => {
        wanted.abort();
        reading?.close();
      };
    }
    setList(null);
    if (!signedIn) return undefined;
    let wanted = true;
    listTrees().then((rows) => { if (wanted) setList(rows); });
    return () => { wanted = false; };
  }, [signedIn]);
  return { list, waiting: list === null && !unread && (ROOM_READS_REPLICA || signedIn) };
}
