import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { failureReason } from '../errors.js';
import { useGymApi } from '../gymRuntime.js';
import { dayLabel, fmtKg, groupByExercise, NO_ROUTINE, routineNameOf, sessionHref, shortDayLabel } from '../log.js';
import { mintId } from '../mint.js';
import { workoutTotals } from '../logbook/history.js';
import { correctionDraft, correctionScheme, correctionWrite } from './correction.js';

export function WorkoutEditor({ session, sets, catalog, log, from, onDelete }) {
  const api = useGymApi();
  const draftKey = `correction:${session.id}`;
  const [restored] = useState(() => api?.workoutSave(draftKey)?.draft);
  const original = restored?.session ?? session;
  const originalSets = restored?.sets ?? sets;
  const [draft, setDraft] = useState(() => restored?.draft ?? correctionDraft(original, originalSets));
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState(false);
  const [selected, setSelected] = useState(restored?.selected ?? originalSets[0]?.exerciseId ?? null);
  const request = useRef(restored?.request ?? null);
  const form = useRef(null);
  const submittedFrom = useRef(window.location.hash);
  const handled = useRef(null);
  const receipt = api?.workoutSave(draftKey);
  const ownReceipt = receipt?.command?.args.requestId === request.current?.id ? receipt : null;
  const pending = ownReceipt?.status === 'pending';
  const busy = saving || pending || !api?.ready;
  const names = new Map(catalog.map((exercise) => [exercise.id, exercise.name]));
  const back = `${sessionHref(session.id)}?from=${encodeURIComponent(from)}`;
  const totals = workoutTotals(originalSets);
  const name = routineNameOf(original) ?? NO_ROUTINE;
  const date = draft.date ? new Date(`${draft.date}T12:00`) : null;
  useEffect(() => {
    if (!ownReceipt) return;
    if (ownReceipt.status === 'pending') { handled.current = null; return; }
    const signature = JSON.stringify([ownReceipt.status, ownReceipt.command]);
    if (handled.current === signature) return;
    handled.current = signature;
    if (ownReceipt.status === 'refused') {
      const error = ownReceipt.error;
      setFailure({ reason: error?.sentence || `Those changes didn’t land — ${failureReason(error)}.`, overlapping: error?.overlapping });
      setSaving(false);
      return;
    }
    if (window.location.hash === submittedFrom.current) window.location.hash = back;
    api.clearWorkoutSave(draftKey, ownReceipt.command).catch(() => {});
  }, [api, ownReceipt, draftKey, back]);
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
    const parsed = correctionWrite(original, draft, request.current?.id ?? mintId('fix_'));
    if (parsed.reason) {
      setFailure(parsed);
      if (parsed.setId) setSelected(draft.sets.find((set) => set.id === parsed.setId)?.exerciseId);
      form.current?.querySelector(parsed.setId ? `[data-set="${parsed.setId}"] [name="${parsed.field}"]` : `[name="${parsed.field}"]`)?.focus();
      return;
    }
    const body = { ...parsed.value, requestId: '' };
    const signature = JSON.stringify(body);
    if (!request.current || request.current.signature !== signature) request.current = { signature, id: mintId('fix_') };
    submittedFrom.current = window.location.hash;
    setFailure(null);
    setSaving(true);
    try {
      await api.correctSession(session.id, { ...parsed.value, requestId: request.current.id }, {
        draftKey, draft: { session: original, sets: originalSets, draft, selected, request: request.current },
      });
    } catch (error) {
      setFailure({ reason: error.sentence || `Those changes didn’t land — ${failureReason(error)}.`, overlapping: error.overlapping });
    } finally {
      setSaving(false);
    }
  };
  return <section className="gym-workout-editor">
    <Back href={back}>{name}</Back>
    <header>
      <h1 className="gym-title">Edit workout</h1>
      <p className="gym-workout-note">{name} · {dayLabel(original.startedAt)}</p>
    </header>
    <div className="gym-workout-desk">
      <form ref={form} onSubmit={save} className="gym-correction-form">
        <fieldset disabled={busy}>
          <div className="gym-workout-fields">
            <label>Routine<input name="routineName" value={draft.routineName} onChange={(event) => setDraft({ ...draft, routineName: event.target.value })} /></label>
            <label className="gym-workout-local">Date<input name="date" type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /><span className="gym-workout-local-value" aria-hidden="true">{date && <>{shortDayLabel(date)}<span className="gym-workout-date-year"> {date.getFullYear()}</span></>}</span></label>
            <label className="gym-workout-local">Start<input name="time" type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /><span className="gym-workout-local-value" aria-hidden="true">{draft.time}</span></label>
          </div>
          <div className="gym-workout-sets">
            <p className="gym-workout-unit">kg × reps</p>
            <div className="gym-workout-movements">
              {groupByExercise(draft.sets).map(([exerciseId, group]) => <section className="gym-workout-movement" key={exerciseId}>
                <button type="button" className="gym-workout-movement-head" aria-expanded={selected === exerciseId} onClick={() => setSelected(selected === exerciseId ? null : exerciseId)}>
                  <span><strong>{names.get(exerciseId) ?? exerciseId}</strong><span className="gym-workout-scheme">{correctionScheme(group)}</span></span>
                  {selected !== exerciseId && <span className="gym-set-rail" aria-label={`${group.length} recorded sets`}>{group.map((set) => <i key={set.id} />)}</span>}
                </button>
                {selected === exerciseId && group.map((set, index) => <div key={set.id} className="gym-workout-set" data-set={set.id}>
                  <div className="gym-correction-row">
                    <span className="gym-set-rail" aria-label={`Set ${index + 1} of ${group.length}`}><i /></span>
                    <input className="gym-num" style={{ '--gym-number-chars': Math.max(2, set.fields.weightKg.length) }} name="weightKg" inputMode="decimal" aria-label={`${names.get(exerciseId)} set ${index + 1} load in kg`} value={set.fields.weightKg} aria-invalid={failure?.setId === set.id && failure.field === 'weightKg'} onChange={(event) => updateSet(set.id, 'weightKg', event.target.value)} />
                    <span className="gym-number-times">×</span>
                    <input className="gym-num" style={{ '--gym-number-chars': Math.max(2, set.fields.reps.length) }} name="reps" inputMode="numeric" aria-label={`${names.get(exerciseId)} set ${index + 1} reps`} value={set.fields.reps} aria-invalid={failure?.setId === set.id && failure.field === 'reps'} onChange={(event) => updateSet(set.id, 'reps', event.target.value)} />
                    <button type="button" className="gym-workout-remove" aria-label={`Delete ${names.get(exerciseId)} set ${index + 1}`} onClick={() => setDraft({ ...draft, sets: draft.sets.filter((row) => row.id !== set.id) })}>×</button>
                  </div>
                  {(set.fields.note || set.fields.rpe) && <p className="gym-workout-set-note">{[set.fields.rpe && `RPE ${set.fields.rpe}`, set.fields.note].filter(Boolean).join(' · ')}</p>}
                </div>)}
                {selected === exerciseId && <button type="button" className="gym-workout-add" onClick={() => addSet(exerciseId)}>+ Add set</button>}
              </section>)}
            </div>
          </div>
          <button type="button" className="gym-workout-add" onClick={() => setPick(!pick)}>+ Add movement</button>
          {pick && <label className="gym-workout-picker">Movement<select value="" onChange={(event) => { if (event.target.value) addSet(event.target.value); }}><option value="">Choose a movement</option>{catalog.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label>}
        </fieldset>
        {failure && <p className="gym-read-failed" role="alert">{failure.reason}{failure.overlapping && <> <a href={sessionHref(failure.overlapping.id)}>Open that session</a></>}</p>}
        <div className="gym-correction-actions"><a className="gym-workout-cancel" href={back}>{pending ? 'Back to workout' : 'Cancel'}</a><Button type="submit" disabled={busy}>{pending ? 'Waiting for the log…' : saving ? 'Saving…' : 'Save changes'}</Button></div>
      </form>
      <aside className="gym-workout-totals">
        <p className="gym-workout-unit">SAVED · {dayLabel(original.startedAt).toUpperCase()}</p>
        <dl>{[[totals.sets, 'sets'], [totals.reps, 'reps'], [Number(fmtKg(totals.tonnageKg)).toLocaleString('en'), 'kg external']].map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p>These are this workout’s own numbers.</p>
        <button type="button" className="gym-short-discard" disabled={busy} onClick={onDelete}>Delete workout</button>
      </aside>
    </div>
  </section>;
}
