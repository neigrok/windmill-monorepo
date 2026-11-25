import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight as SwapIcon, Plus } from 'lucide-react';
import { Button, Select } from '../../../design-system/index.js';
import { failureReason } from '../errors.js';
import { t } from '../i18n/index.js';
import { clockOf, setReading } from '../log.js';
import { typedNumber } from './workout.js';

// The rests a movement may take in this workout, 15 s to 15 min, as the phones offer them; none is the lifter's preference.
const RESTS = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 720, 900];
const MAX_SETS = 20;

const textOf = (value) => (value === null || value === undefined ? '' : String(value));
// One movement's entry in this workout's plan as Edit sets drafts it (iOS 03.29): each planned set keeps the place it
// opened at, and its rest. Saved, the draft becomes the operations that take the entry as it opened to the entry as drawn:
// sets taken out last to first so each earlier place stands, each kept set retargeted at its new place, added sets copying
// the last target before they are retargeted, then the rest.
class EditSetsDraft {
  constructor(entry) {
    this.opened = entry;
    this.rows = (entry.sets ?? []).map((target, at) => ({ key: at, origin: at, reps: textOf(target.reps), weightKg: textOf(target.weightKg) }));
    this.rest = entry.restSeconds ?? null;
    this.minted = this.rows.length;
  }

  static targetOf(row) { return { reps: typedNumber(row.reps), weightKg: typedNumber(row.weightKg) }; }
  static same(left, right) { return (left?.reps ?? null) === (right?.reps ?? null) && (left?.weightKg ?? null) === (right?.weightKg ?? null); }

  get entry() {
    return { exerciseId: this.opened.exerciseId, ...(this.rows.length ? { sets: this.rows.map(EditSetsDraft.targetOf) } : {}),
      ...(this.rest === null ? {} : { restSeconds: this.rest }) };
  }

  edits(index) {
    const opening = this.opened.sets ?? [];
    const kept = new Set(this.rows.flatMap((row) => (row.origin === null ? [] : [row.origin])));
    const edits = opening.map((_, at) => at).reverse().filter((at) => !kept.has(at)).map((set) => ({ kind: 'removeSet', index, set }));
    this.rows.forEach((row, place) => {
      const target = EditSetsDraft.targetOf(row);
      if (row.origin === null) {
        edits.push({ kind: 'addSet', index });
        const copied = place === 0 ? { reps: null, weightKg: null } : EditSetsDraft.targetOf(this.rows[place - 1]);
        if (!EditSetsDraft.same(copied, target)) edits.push({ kind: 'retarget', index, set: place, target });
      } else if (!EditSetsDraft.same(opening[row.origin], target)) edits.push({ kind: 'retarget', index, set: place, target });
    });
    if (this.rest !== (this.opened.restSeconds ?? null)) edits.push({ kind: 'setRest', index, restSeconds: this.rest });
    return edits;
  }

  // The draft over the entry as it now stands, its sets and rest as typed: Save mine.
  over(latest) {
    const draft = new EditSetsDraft(latest);
    draft.rows = this.rows.map((row, at) => ({ ...row, key: at, origin: at < (latest.sets ?? []).length ? at : null }));
    draft.rest = this.rest;
    draft.minted = draft.rows.length;
    return draft;
  }

  with(change) { return Object.assign(Object.create(EditSetsDraft.prototype), this, change); }
}

// Edit sets (WD3.2): this workout's plan for one movement with nothing logged — its sets, its rest, Swap and Remove — saved
// whole in one write against the plan it opened on. A plan another tab or device changed first is refused stale and the
// draft stays (WD5): while the answer stands the sets and the rest stay editable, Save, Add set, Swap and Remove wait, and
// Use latest reopens on the plan as it stands or Save mine writes the draft over it.
export function EditSets({ view, exerciseId, log, movementName, onRevise, onSwap, onClose }) {
  const name = movementName(exerciseId);
  const entryIn = (plan) => plan?.entries.find((entry) => entry.exerciseId === exerciseId) ?? null;
  const [base, setBase] = useState(view.plan);
  const [draft, setDraft] = useState(() => new EditSetsDraft(entryIn(view.plan) ?? { exerciseId }));
  const [stale, setStale] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [saving, setSaving] = useState(false);
  const closed = useRef(false);
  const index = base?.entries.findIndex((entry) => entry.exerciseId === exerciseId) ?? -1;

  // A set that lands on the movement while the panel is open, from this tab or another device, closes it unchanged.
  const logged = view.movements.find((movement) => movement.exerciseId === exerciseId)?.logged ?? 0;
  useEffect(() => {
    if (logged === 0 || closed.current) return;
    closed.current = true;
    log.say(t('gym.workout.loggedNow', { movement: name }));
    onClose();
  }, [logged, log, name, onClose]);

  const rows = draft.rows;
  const editRow = (key, field, value) => { setRefusal(null); setDraft(draft.with({ rows: rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)) })); };
  const addSet = () => {
    if (rows.length >= MAX_SETS) return;
    const last = rows.at(-1);
    setDraft(draft.with({ rows: [...rows, { key: draft.minted, origin: null, reps: last?.reps ?? '', weightKg: last?.weightKg ?? '' }], minted: draft.minted + 1 }));
  };
  const save = async (edits, against) => {
    if (saving) return;
    if (edits.length === 0) { onClose(); return; }
    setSaving(true);
    try {
      await onRevise(edits, against);
    } catch (error) {
      setSaving(false);
      if (error?.code === 'stale') { setStale(entryIn(view.plan)); return; }
      setRefusal(error?.sentence ?? t('gym.workout.planUnchanged', { reason: failureReason(error) }));
    }
  };
  const useLatest = () => { setStale(null); setBase(view.plan); setDraft(new EditSetsDraft(entryIn(view.plan) ?? { exerciseId })); };
  const saveMine = () => {
    const latest = entryIn(view.plan);
    if (latest === null) { useLatest(); return; }
    const mine = draft.over(latest);
    const at = view.plan.entries.findIndex((entry) => entry.exerciseId === exerciseId);
    setBase(view.plan);
    setDraft(mine);
    setStale(null);
    save(mine.edits(at), view.plan);
  };

  return (
    <form className="gym-live-edit" aria-label={t('gym.workout.editSets')} onSubmit={(event) => { event.preventDefault(); save(draft.edits(index), base); }}>
      <header className="gym-live-edit-head">
        <button type="button" className="gym-live-edit-cancel" onClick={onClose}>{t('gym.common.cancel')}</button>
        <span className="gym-live-edit-title"><strong>{t('gym.workout.editSets')}</strong><small>{t('gym.workout.thisWorkoutOf', { movement: name })}</small></span>
        <button type="submit" className="gym-live-edit-save" disabled={saving || Boolean(stale)}>{t('gym.workout.save')}</button>
      </header>
      {stale && <StaleNotice name={name} latest={stale} mine={draft.entry} />}
      <ol className="gym-live-edit-sets">
        {rows.map((row, place) => (
          <li key={row.key} className="gym-live-edit-set">
            <span className="gym-set-rail" aria-hidden="true"><i /></span>
            <input className="gym-num" inputMode="decimal" value={row.weightKg} placeholder={t('gym.workout.lastLoad')}
              aria-label={t('gym.workout.setLoad', { position: place + 1 })} style={{ '--gym-number-chars': Math.max(2, row.weightKg.length) }}
              onChange={(event) => editRow(row.key, 'weightKg', event.target.value)} />
            <span className="gym-number-times" aria-hidden="true">×</span>
            <input className="gym-num" inputMode="numeric" value={row.reps} placeholder={t('gym.workout.maxReps')}
              aria-label={t('gym.workout.setReps', { position: place + 1 })} style={{ '--gym-number-chars': Math.max(2, row.reps.length) }}
              onChange={(event) => editRow(row.key, 'reps', event.target.value)} />
            <button type="button" className="gym-live-edit-remove" aria-label={t('gym.workout.removeSet', { position: place + 1 })}
              onClick={() => setDraft(draft.with({ rows: rows.filter((each) => each.key !== row.key) }))}>×</button>
          </li>
        ))}
      </ol>
      {!stale && (
        <button type="button" className="gym-live-add" onClick={addSet} disabled={rows.length >= MAX_SETS}>
          <Plus size={16} aria-hidden="true" /> {t('gym.workout.addSet')}
        </button>
      )}
      <div className="gym-live-edit-rest">
        <span id="gym-live-rest">{t('gym.workout.rest')}</span>
        <Select labelledBy="gym-live-rest" value={draft.rest === null ? 'default' : String(draft.rest)} onChange={(value) => setDraft(draft.with({ rest: value === 'default' ? null : Number(value) }))}
          options={[{ value: 'default', label: t('gym.workout.restDefault') }, ...RESTS.map((seconds) => ({ value: String(seconds), label: clockOf(seconds * 1000) }))]} />
      </div>
      {refusal && <p className="gym-live-refusal" role="alert">{refusal}</p>}
      {!stale && (
        <div className="gym-live-edit-more">
          <button type="button" className="gym-live-edit-swap" onClick={() => onSwap(draft.edits(index), base)}>
            <SwapIcon size={16} aria-hidden="true" /> {t('gym.workout.swapMovement')}
          </button>
          <button type="button" className="gym-live-edit-drop" onClick={() => save([{ kind: 'removeMovement', index }], base)}>{t('gym.workout.removeFromWorkout')}</button>
        </div>
      )}
      {stale ? (
        <div className="gym-live-band">
          <Button variant="secondary" onClick={useLatest}>{t('gym.workout.useLatest')}</Button>
          <Button onClick={saveMine}>{t('gym.workout.saveMine')}</Button>
        </div>
      ) : (
        <div className="gym-live-band is-edit">
          <button type="button" className="gym-live-band-cancel" onClick={onClose}>{t('gym.common.cancel')}</button>
          <Button type="submit" disabled={saving}>{t('gym.workout.save')}</Button>
        </div>
      )}
    </form>
  );
}

// What differs between the plan as it stands and the draft, latest beside yours, in the row's own numbers.
function StaleNotice({ name, latest, mine }) {
  const theirs = latest.sets ?? [], ours = mine.sets ?? [];
  const lines = Array.from({ length: Math.max(theirs.length, ours.length) }, (_, at) => at)
    .filter((at) => !EditSetsDraft.same(theirs[at], ours[at]))
    .map((at) => ({ label: t('gym.workout.staleSet', { position: at + 1 }),
      latest: theirs[at] ? setReading(theirs[at]) : t('gym.workout.staleNone'), mine: ours[at] ? setReading(ours[at]) : t('gym.workout.staleNone') }));
  if ((latest.restSeconds ?? null) !== (mine.restSeconds ?? null)) {
    const rest = (seconds) => (seconds == null ? t('gym.workout.restDefault') : clockOf(seconds * 1000));
    lines.push({ label: t('gym.workout.rest'), latest: rest(latest.restSeconds), mine: rest(mine.restSeconds) });
  }
  return (
    <section className="gym-live-stale" role="alert">
      <h2>{t('gym.workout.staleTitle', { movement: name })}</h2>
      <p>{t('gym.workout.staleLine')}</p>
      {lines.map((line) => (
        <p key={line.label} className="gym-live-stale-line">
          <span>{line.label}</span>
          <span><small>{t('gym.workout.staleLatest')}</small> {line.latest} <small>{t('gym.workout.staleYours')}</small> <strong>{line.mine}</strong></span>
        </p>
      ))}
    </section>
  );
}
