// The newest roadmap as the home card and the landing offer it back: the person's roadmaps it is the first of, its name,
// a short name for a button, how long ago it was tended, and the sentence that says so around a progress figure each
// surface draws its own way.

import { useEffect, useState } from 'react';
import { t } from './i18n/entry/index.js';
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
// changes; elsewhere the server's list (`GET /v1/trees`), read once while `signedIn`. Null until the first answer, and
// empty where none could be read. The copy's reading loads with its first use, so neither surface carries the room's
// modules where the switch is off.
export function useYourRoadmaps(signedIn) {
  const [roadmaps, setRoadmaps] = useState(null);
  useEffect(() => {
    if (ROOM_READS_REPLICA) {
      const wanted = new AbortController();
      let reading = null;
      import('./room/ReplicaReading.js').then(({ ReplicaReading }) => {
        if (wanted.signal.aborted) return true;
        reading = new ReplicaReading({ treeId: null });
        return reading.followRoadmaps({ signal: wanted.signal, onList: setRoadmaps });
      }, () => false).then((stood) => { if (!stood && !wanted.signal.aborted) setRoadmaps([]); });
      return () => {
        wanted.abort();
        reading?.close();
      };
    }
    setRoadmaps(null);
    if (!signedIn) return undefined;
    let wanted = true;
    listTrees().then((rows) => { if (wanted) setRoadmaps(rows); });
    return () => { wanted = false; };
  }, [signedIn]);
  return roadmaps;
}
