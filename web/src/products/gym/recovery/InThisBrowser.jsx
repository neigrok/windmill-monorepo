import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Menu } from '../../../design-system/index.js';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { failureReason } from '../errors.js';
import { useGymApi } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { daysAgo, shortDayLabel, timeLabel } from '../log.js';
import './recovery.css';

// A start that lost a race with another device's (spec §4, WD4.3): as its refusal reaches the room its sets are saved for
// In this browser, and the room says so once, with the way to them. Another tab's save says nothing here.
export function useRefusedStarts(log) {
  const api = useGymApi();
  const { notices } = useSyncRecords('self/gym');
  const asked = useRef(new Set());
  const { say } = log;
  useEffect(() => {
    if (!api) return;
    for (const notice of notices) {
      if (notice.dismissed || asked.current.has(notice.id)) continue;
      asked.current.add(notice.id);
      api.saveRefusedStart(notice.id).then((sets) => {
        if (sets === 0) return;
        say(t('gym.recovery.lostRace', { count: sets }), { action: { label: t('gym.recovery.viewSets'), run: () => { window.location.hash = '#/gym/log'; } } });
      });
    }
  }, [api, notices, say]);
}

// In this browser (WD9.3): the workouts this browser saved for the account that the account has not taken, a signed-out
// one it could not join or a start that lost a race, each with why it waits and its one answer. Signed in only: signed
// out, the room says nothing of where the work is kept (R-6). The log draws it at the head of its index from 801px and
// above its filters below, so `placement` names which of the two this one is.
export function InThisBrowser({ log, placement }) {
  const api = useGymApi();
  const records = useSyncRecords('self/gym');
  const copies = useMemo(() => (api ? api.browserCopies() : []), [api, records]);
  const hidden = log.hidden('copy');
  const shown = copies.filter((copy) => !hidden.has(copy.id));
  const [answering, setAnswering] = useState(null);
  if (shown.length === 0) return null;

  const answer = async (copy) => {
    setAnswering(copy.id);
    try { await (copy.answer === 'keep' ? api.keepCopy(copy.id) : api.retryCopy(copy.id)); }
    catch (error) { log.say(t('gym.recovery.notAdded', { reason: failureReason(error) })); }
    finally { setAnswering(null); }
  };
  const discard = (copy) => log.withhold({ kind: 'copy', id: copy.id, line: t('gym.recovery.discarded'),
    send: () => api.discardCopy(copy.id), refused: (error) => log.say(t('gym.recovery.notDiscarded', { reason: failureReason(error) })) });

  return (
    <section className={`gym-browser-copies is-${placement}`} aria-label={t('gym.recovery.title')}>
      <h2 className="gym-browser-copies-head">{t('gym.recovery.title')}</h2>
      <ul>
        {shown.map((copy) => (
          <li className="gym-browser-copy" key={copy.id}>
            <div className="gym-browser-copy-head">
              <span className="gym-browser-copy-title">{copy.title}</span>
              <span className="gym-browser-copy-meta">{t('gym.recovery.meta', { day: dayOf(copy.startedAt), time: timeLabel(copy.startedAt), sets: copy.sets })}</span>
              {copy.reason && <Menu label={t('gym.recovery.moreFor', { name: copy.title })} items={[{ label: t('gym.recovery.discard'), run: () => discard(copy) }]} />}
            </div>
            <p className="gym-browser-copy-line">{copy.reason ? reasonLine(copy) : t('gym.recovery.adding')}</p>
            {copy.answer && <Button variant="secondary" size="sm" disabled={answering !== null} onClick={() => answer(copy)}>
              {copy.answer === 'keep' ? t('gym.recovery.keep') : t('gym.recovery.retry')}
            </Button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// `Today`, `Yesterday`, or the day's date.
function dayOf(ms) {
  const days = daysAgo(ms);
  return days <= 1 ? t('gym.recovery.day', { days: Math.max(0, days) }) : shortDayLabel(ms);
}

// Why a copy waits, in one sentence; the web has no editor for a copy, so a sentence names no way out it cannot offer.
function reasonLine(copy) {
  return {
    'session-open': t('gym.recovery.reason.accountOpen'),
    'session-overlap': t('gym.recovery.reason.overlap'),
    'id-taken': t('gym.recovery.reason.taken'),
    'bad-instant': t('gym.recovery.reason.badTime'),
    'too-many-sets': t('gym.recovery.reason.tooManySets'),
    'unknown-exercise': t('gym.recovery.reason.unknownMovement'),
    'session-finished': t('gym.recovery.reason.strandedSets', { count: copy.sets }),
    unsent: t('gym.recovery.reason.unsent'),
    'invalid-set': t('gym.recovery.reason.refused'),
    other: t('gym.recovery.reason.refused'),
  }[copy.reason];
}
