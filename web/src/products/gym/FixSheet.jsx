import React, { useRef, useState } from 'react';
import { Button } from '../../design-system/index.js';
import { fixOf, fixSubtitle, NO_RPE_LABEL, RPE_RUNGS, SET_NOTE_CAPTION, SET_NOTE_LABEL, setNoteRefusal, showsSetNoteCount, setNoteCountLabel, isSetNoteOverCap } from './fix.js';
import { alsoReadsLabel, dayLabel, setLoadLabel } from './log.js';
import { correctionScheme, readSetFields, setFields } from './correction/correction.js';

export function FixSheet({ set, sets = [set], movement, session, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => setFields(set));
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const form = useRef(null);
  const parsed = readSetFields(draft);
  const group = sets.filter((row) => row.exerciseId === set.exerciseId);
  const ratings = [null, ...(set.rpe != null && !RPE_RUNGS.includes(set.rpe) ? [set.rpe] : []), ...RPE_RUNGS];
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (parsed.reason) {
      setFailure(parsed);
      form.current?.querySelector(`[name="${parsed.field}"]`)?.focus();
      return;
    }
    setBusy(true);
    const reason = await onSave(fixOf(set, parsed.value));
    if (reason) {
      setFailure({ reason, field: 'weightKg' });
      form.current?.querySelector('[name="weightKg"]')?.focus();
    }
    setBusy(false);
  };
  const update = (field, value) => { setFailure(null); setDraft({ ...draft, [field]: value }); };
  return <section className="gym-fix-page" aria-label="Fix set">
    <header className="gym-fix-head">
      <div><h1 className="gym-title">Fix set</h1><p className="gym-fix-sub">{fixSubtitle(movement, set)}{session.startedAt != null ? ` · ${dayLabel(session.startedAt)}` : ''}</p></div>
      <button type="button" className="gym-fix-cancel" onClick={onClose} disabled={busy}>Cancel</button>
    </header>
    <form ref={form} className="gym-fix-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <p className="gym-fix-units">kg × reps</p>
        <div className="gym-fix-movement"><h2>{movement}</h2><p>{correctionScheme(group.map((row) => ({ fields: setFields(row) })))}</p></div>
        {group.map((row) => row.id !== set.id ? <div key={row.id} className="gym-fix-sibling"><span className="gym-set-rail" aria-hidden="true"><i /></span><span>{setLoadLabel(row, 'kg')}</span></div> : <React.Fragment key={row.id}>
          <div className="gym-fix-row">
            <span className="gym-set-rail" aria-hidden="true"><i /></span>
            <input className="gym-num" style={{ '--gym-number-chars': Math.max(2, draft.weightKg.length) }} name="weightKg" inputMode="decimal" aria-label="Load in kg" aria-invalid={failure?.field === 'weightKg'} aria-describedby={failure?.field === 'weightKg' ? 'gym-fix-refusal' : undefined} value={draft.weightKg} onChange={(event) => update('weightKg', event.target.value)} />
            <span className="gym-number-times" aria-hidden="true">×</span>
            <input className="gym-num" style={{ '--gym-number-chars': Math.max(2, draft.reps.length) }} name="reps" inputMode="numeric" aria-label="Reps" aria-invalid={failure?.field === 'reps'} aria-describedby={failure?.field === 'reps' ? 'gym-fix-refusal' : undefined} value={draft.reps} onChange={(event) => update('reps', event.target.value)} />
            <button type="button" className="gym-fix-remove" aria-label="Delete set" onClick={onDelete}>×</button>
          </div>
          {failure && failure.field !== 'note' && <p id="gym-fix-refusal" className="gym-fix-refusal" role="alert">{failure.reason}</p>}
          <div className="gym-fix-extra">
            {alsoReadsLabel(parsed.value?.weightKg) && <p className="gym-quiet">{alsoReadsLabel(parsed.value.weightKg)}</p>}
            <div className="gym-fix-effort"><span id="gym-fix-rpe-label">RPE</span><div className="gym-fix-ratings" role="group" aria-labelledby="gym-fix-rpe-label">{ratings.map((rating) => <button key={rating ?? 'none'} type="button" aria-pressed={draft.rpe === (rating == null ? '' : String(rating))} onClick={() => update('rpe', rating == null ? '' : String(rating))}>{rating ?? NO_RPE_LABEL}</button>)}</div></div>
            <label className="gym-fix-note" htmlFor="gym-set-note"><span>{SET_NOTE_LABEL}{showsSetNoteCount(draft.note) && <span className={isSetNoteOverCap(draft.note) ? 'gym-name-count is-over' : 'gym-name-count'}>{setNoteCountLabel(draft.note)}</span>}</span><textarea rows="1" name="note" id="gym-set-note" aria-label={SET_NOTE_LABEL} aria-describedby="gym-set-note-caption" aria-invalid={Boolean(setNoteRefusal(draft.note))} placeholder="felt heavy" value={draft.note} onChange={(event) => update('note', event.target.value)} /></label>
            <p id="gym-set-note-caption" className="gym-fix-note-caption">{SET_NOTE_CAPTION}</p>
            {setNoteRefusal(draft.note) && <p className="gym-fix-refusal" role="alert">{setNoteRefusal(draft.note)}</p>}
          </div>
        </React.Fragment>)}
      </fieldset>
      <p className="gym-fix-proof">Changes update this saved set. The workout stays in your log.</p>
      <footer className="gym-fix-actions"><button type="button" className="gym-fix-delete" onClick={onDelete} disabled={busy}>Delete set</button><Button type="submit" disabled={busy} ariaBusy={busy}>{busy ? 'Saving…' : 'Save changes'}</Button></footer>
    </form>
  </section>;
}
