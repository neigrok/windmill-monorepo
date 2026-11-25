import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Menu, Switch } from '../../../design-system/index.js';
import { failureReason } from '../errors.js';
import { KeepAsRoutine } from '../Finish.jsx';
import { useGymApi, workoutStep } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { dayLabel, entryLabel, nameOfMovement, sessionHref, timeLabel, tonnageLabel } from '../log.js';
import { diffRows } from '../proposals.js';
import { useDomainRead } from '../useDomainRead.js';
import { receiptOf } from './workout.js';

// What moved of two readings, the half both share left out: `10 × 8` to `12.5 × 8` reads `10 → 12.5` and `3 × 8 · 10`
// to `4 × 8 · 10` reads `3 × 8 → 4 × 8`; readings that differ in both halves, or are not split alike, read whole.
function movedPart(from, to) {
  for (const separator of [' · ', ' × ']) {
    const at = [from.lastIndexOf(separator), to.lastIndexOf(separator)];
    if (at[0] < 0 || at[1] < 0) continue;
    const heads = [from.slice(0, at[0]), to.slice(0, at[1])];
    const tails = [from.slice(at[0] + separator.length), to.slice(at[1] + separator.length)];
    if (tails[0] === tails[1] && heads[0] !== heads[1]) return heads;
    if (heads[0] === heads[1] && tails[0] !== tails[1]) return separator === ' × ' ? tails.map((tail) => `× ${tail}`) : tails;
  }
  return [from, to];
}

// The workout's plan changes as the receipt lists them (WD3.3): one flat row a change, what changed (the movement, and
// which set or its rest) and its values, the routine's struck through before the workout's.
function changeLines(rows, catalog) {
  return rows.flatMap((row) => {
    const movement = row.exerciseId ? nameOfMovement(catalog, row.exerciseId) : null;
    if (row.kind === 'retargeted') {
      return row.moves.map((move) => {
        const [from, to] = movedPart(move.from, move.to);
        return { what: move.field === 'sets' ? movement : t('gym.workout.changeOf', { movement, field: move.field }), from, to };
      });
    }
    if (row.kind === 'added') return [{ what: movement, word: t('gym.workout.changeAdded'), to: row.targets }];
    if (row.kind === 'removed') return [{ what: movement, word: t('gym.workout.changeRemoved') }];
    if (row.kind === 'reordered') return [{ what: t('gym.workout.changeOrder') }];
    return [];
  });
}

// The receipt of a workout this page just finished (WD3.3): the times, three figures, what each movement came to, and,
// when this workout's plan changed, its changes against the routine with *Save to {routine}*, off until the lifter turns
// it on. Done saves the routine only then, and opens the workout in The log. Its ⋯ discards the workout through the
// room's held delete, whose Undo is the way back (WD3.5). Nothing logged, it offers to drop the workout instead.
export function Receipt({ id, log }) {
  const api = useGymApi();
  const read = useDomainRead((reading) => receiptOf(reading, id), [id]);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const receipt = read.data;
  if (read.phase !== 'ready' || !api?.ready) return <p className="gym-quiet">{t('gym.workout.opening')}</p>;
  if (!receipt || log.hidden('session').has(id)) return <p className="gym-quiet">{t('gym.finish.sessionAbsent')}</p>;

  const { session, sets, movements, changes, routine } = receipt;
  const discard = () => {
    log.holdDelete({ kind: 'session', id, refused: (error) => log.say(t('gym.log.sessionNotDiscarded', { reason: failureReason(error) })) });
    window.location.hash = '#/gym/log';
  };
  const rows = diffRows({ changes: changes.changes, changeCount: changes.changeCount }).filter((row) => row.kind !== 'kept');
  const done = async () => {
    if (busy) return;
    if (save && changes.offer === 'save' && routine) {
      setBusy(true);
      try {
        await api.replaceRoutine(routine.id, { ...routine, entries: session.plan.entries }, routine);
        workoutStep('gym_receipt_plan_saved', { outcome: 'ok' });
      } catch (error) {
        setBusy(false);
        workoutStep('gym_receipt_plan_saved', { outcome: error?.code ? 'refused' : 'failed' });
        log.say(error.sentence ?? t('gym.workout.planNotSaved', { routine: routine.name, reason: failureReason(error) }));
        return;
      }
    }
    window.location.hash = sessionHref(id);
  };
  const minutes = Math.max(1, Math.round(((session.finishedAt ?? session.startedAt) - session.startedAt) / 60000));

  return (
    <section className="gym-live-receipt" aria-labelledby="gym-receipt-title">
      <header className="gym-live-receipt-head">
        <span>
          <h1 id="gym-receipt-title" className="gym-title">{t('gym.workout.wellDone')}</h1>
          <p className="gym-live-receipt-when">{t('gym.workout.receiptWhen', { name: session.name ?? t('gym.workout.untitled'), day: dayLabel(session.startedAt),
            from: timeLabel(session.startedAt), to: timeLabel(session.finishedAt ?? session.startedAt) })}</p>
        </span>
        <Menu label={t('gym.workout.receiptMenu')} items={[{ label: t('gym.workout.discardWorkout'), tone: 'danger', icon: <Trash2 size={16} aria-hidden="true" />, run: discard }]} />
      </header>
      {sets.length === 0 ? (
        <section className="gym-short">
          <p className="gym-short-line">{t('gym.workout.nothingLogged')}</p>
          <div className="gym-finish-foot">
            <a className="gym-short-keep" href="#/gym/log">{t('gym.finish.keepIt')}</a>
            <button type="button" className="gym-short-discard" onClick={discard}>{t('gym.workout.discardWorkout')}</button>
          </div>
        </section>
      ) : (
        <>
          <ul className="gym-live-figures">
            <li><strong>{minutes}</strong><span>{t('gym.workout.minutesFigure', { count: minutes })}</span></li>
            <li><strong>{sets.length}</strong><span>{t('gym.workout.setsFigure', { count: sets.length })}</span></li>
            <li><strong>{receipt.volumeKg === null ? '—' : tonnageLabel(receipt.volumeKg)}</strong><span>{t('gym.workout.volumeFigure')}</span></li>
          </ul>
          <ul className="gym-live-receipt-movements">
            {movements.map((movement) => (
              <li key={movement.exerciseId}>
                <span>{nameOfMovement(log.catalog, movement.exerciseId)}</span>
                <span className="gym-live-receipt-scheme">{entryLabel({ sets: movement.sets.map((set) => ({ reps: set.reps, weightKg: set.weightKg })) })}</span>
              </li>
            ))}
          </ul>
          {rows.length > 0 && (
            <section className="gym-live-changes" aria-labelledby="gym-receipt-changes">
              <h2 id="gym-receipt-changes">{t('gym.workout.planChanges', { count: changes.changeCount })}</h2>
              <ul>
                {changeLines(rows, log.catalog).map((line, at) => (
                  <li key={at} className="gym-live-change">
                    <span className="gym-live-change-what">{line.what}</span>
                    {(line.word || line.to) && (
                      <span className="gym-live-change-values">
                        {line.word && <span className="is-word">{line.word}</span>}
                        {line.from && <s>{line.from}</s>}
                        {line.from && <span aria-hidden="true">→</span>}
                        {line.to && <span className="is-now">{line.to}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {changes.offer === 'save' && routine && (
                <div className="gym-live-changes-save">
                  <Switch checked={save} onChange={setSave} label={t('gym.workout.saveTo', { routine: routine.name })} />
                </div>
              )}
              {changes.offer === 'routineChanged' && routine && <p className="gym-quiet">{t('gym.workout.routineChanged', { routine: routine.name })}</p>}
            </section>
          )}
          {!session.routineId && <KeepAsRoutine session={session} sets={sets} catalog={log.catalog} log={log} />}
          <div className="gym-live-receipt-actions">
            <Button size="lg" onClick={done} disabled={busy}>{t('gym.workout.done')}</Button>
          </div>
        </>
      )}
    </section>
  );
}
