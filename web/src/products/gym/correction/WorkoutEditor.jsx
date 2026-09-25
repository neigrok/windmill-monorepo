import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { failureReason, gymApi } from '../gymApi.js';
import { dayLabel, fmtKg, groupByExercise, NO_ROUTINE, routineNameOf, sessionHref } from '../log.js';
import { mintId } from '../mint.js';
import { workoutTotals } from '../logbook/history.js';
import { correctionDraft, correctionScheme, correctionWrite } from './correction.js';

export function WorkoutEditor({ session, sets, catalog, log, from, onDelete }) {
  const [draft, setDraft] = useState(() => correctionDraft(session, sets));
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const [selected, setSelected] = useState(sets[0]?.exerciseId ?? null);
  const request = useRef(null);
  const form = useRef(null);
  const names = new Map(catalog.map((exercise) => [exercise.id, exercise.name]));
  const back = `${sessionHref(session.id)}?from=${encodeURIComponent(from)}`;
  const totals = workoutTotals(sets);
  const name = routineNameOf(session) ?? NO_ROUTINE;
  useEffect(() => {
    if (!failure) return;
    form.current?.querySelector(failure.setId ? `[data-set="${failure.setId}"] [name="${failure.field}"]` : `[name="${failure.field}"]`)?.focus();
  }, [failure, selected]);
  const updateSet = (id, field, value) => {
    setFailure(null);
    setDraft((current) => ({ ...current, sets: current.sets.map((set) => set.id === id ? { ...set, fields: { ...set.fields, [field]: value } } : set) }));
  };
  const addSet = (exerciseId) => {
    const previous = draft.sets.filter((set) => set.exerciseId === exerciseId).at(-1);
    const next = { id: mintId('set_'), exerciseId, kind: 'working', fields: previous ? { ...previous.fields, rpe: '', note: '' } : { weightKg: '', reps: '', rpe: '', note: '' } };
    setDraft((current) => ({ ...current, sets: [...current.sets, next] }));
    setPick(false);
    setSelected(exerciseId);
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    const parsed = correctionWrite(session, draft, request.current?.id ?? mintId('fix_'));
    if (parsed.reason) {
      setFailure(parsed);
      if (parsed.setId) setSelected(draft.sets.find((set) => set.id === parsed.setId)?.exerciseId);
      form.current?.querySelector(parsed.setId ? `[data-set="${parsed.setId}"] [name="${parsed.field}"]` : `[name="${parsed.field}"]`)?.focus();
      return;
    }
    const body = { ...parsed.value, requestId: '' };
    const signature = JSON.stringify(body);
    if (!request.current || request.current.signature !== signature) request.current = { signature, id: mintId('fix_') };
    setBusy(true);
    try {
      await gymApi.correctSession(session.id, { ...parsed.value, requestId: request.current.id });
      await log.reloadLog();
      window.location.hash = back;
    } catch (error) {
      setFailure({ reason: error.detail || `Those changes didn’t land — ${failureReason(error)}.` });
      setBusy(false);
    }
  };
  return <section className="gym-workout-editor">
    <Back href={back}>{name}</Back>
    <h1 className="gym-title">Edit workout</h1>
    <p className="gym-workout-note">{name} · {dayLabel(session.startedAt)}</p>
    <div className="gym-workout-desk">
      <form ref={form} onSubmit={save} className="gym-correction-form">
        <fieldset disabled={busy}>
          <div className="gym-workout-fields">
            <label>Routine<input name="routineName" value={draft.routineName} onChange={(event) => setDraft({ ...draft, routineName: event.target.value })} /></label>
            <label>Date<input name="date" type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
            <label>Start<input name="time" type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>
          </div>
          <p className="gym-workout-unit">kg × reps</p>
          {groupByExercise(draft.sets).map(([exerciseId, group]) => <section className="gym-workout-movement" key={exerciseId}>
            <button type="button" className="gym-workout-movement-head" aria-expanded={selected === exerciseId} onClick={() => setSelected(selected === exerciseId ? null : exerciseId)}>
              <span><strong>{names.get(exerciseId) ?? exerciseId}</strong><span className="gym-workout-scheme">{correctionScheme(group)}</span></span>
              {selected !== exerciseId && <span className="gym-set-rail" aria-label={`${group.length} recorded sets`}>{group.map((set) => <i key={set.id} />)}</span>}
            </button>
            {selected === exerciseId && group.map((set, index) => <div key={set.id} className="gym-workout-set" data-set={set.id}>
              <div className="gym-correction-row">
                <span className="gym-set-rail" aria-label={`Set ${index + 1} of ${group.length}`}><i /></span>
                <input className="gym-num" name="weightKg" inputMode="decimal" aria-label={`${names.get(exerciseId)} set ${index + 1} load in kg`} value={set.fields.weightKg} aria-invalid={failure?.setId === set.id && failure.field === 'weightKg'} onChange={(event) => updateSet(set.id, 'weightKg', event.target.value)} />
                <span className="gym-number-times">×</span>
                <input className="gym-num" name="reps" inputMode="numeric" aria-label={`${names.get(exerciseId)} set ${index + 1} reps`} value={set.fields.reps} aria-invalid={failure?.setId === set.id && failure.field === 'reps'} onChange={(event) => updateSet(set.id, 'reps', event.target.value)} />
                <button type="button" className="gym-workout-remove" aria-label={`Delete ${names.get(exerciseId)} set ${index + 1}`} onClick={() => setDraft({ ...draft, sets: draft.sets.filter((row) => row.id !== set.id) })}>×</button>
              </div>
              {(set.fields.note || set.fields.rpe) && <p className="gym-workout-set-note">{[set.fields.rpe && `RPE ${set.fields.rpe}`, set.fields.note].filter(Boolean).join(' · ')}</p>}
            </div>)}
            {selected === exerciseId && <button type="button" className="gym-workout-add" onClick={() => addSet(exerciseId)}>+ Add set</button>}
          </section>)}
          <button type="button" className="gym-workout-add" onClick={() => setPick(!pick)}>+ Add movement</button>
          {pick && <label className="gym-workout-picker">Movement<select value="" onChange={(event) => { if (event.target.value) addSet(event.target.value); }}><option value="">Choose a movement</option>{catalog.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label>}
        </fieldset>
        {failure && <p className="gym-read-failed" role="alert">{failure.reason}</p>}
        <div className="gym-correction-actions"><a className="gym-workout-cancel" href={back}>Cancel</a><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button></div>
      </form>
      <aside className="gym-workout-totals">
        <p className="gym-workout-unit">SAVED · {dayLabel(session.startedAt).toUpperCase()}</p>
        <dl>{[[totals.sets, 'sets'], [totals.reps, 'reps'], [Number(fmtKg(totals.tonnageKg)).toLocaleString('en'), 'kg external']].map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p>These are this workout’s own numbers.</p>
        <button type="button" className="gym-short-discard" onClick={onDelete}>Delete workout</button>
      </aside>
    </div>
  </section>;
}
