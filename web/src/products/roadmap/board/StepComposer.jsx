import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS } from '../theme.js';
import { StepDraft } from './StepDraft.js';
import { PrerequisitePicker, useDraftFocus, useDraftViewport } from './PrerequisitePicker.jsx';
import { StepIcons } from './StepIcons.jsx';
import { COLUMN_TITLES, COMPOSER, DISCARD_DRAFT, SAVE_FAILURE, prerequisiteNames } from './copy.js';
import './composer.css';

export function StepComposer({ tree, completed, legend, band, onCreate, onClose }) {
  const phone = band === 'phone';
  const viewport = useDraftViewport(phone);
  const [stored, setDraft] = useState(() => new StepDraft());
  const draft = stored.reconcile(tree);
  const [picker, setPicker] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nameError, setNameError] = useState(null);
  const request = useRef(null);
  const dialog = useRef(null);
  const name = useRef(null);
  const titleId = useId();
  const nameId = useId();
  const errorId = useId();
  const descriptionId = useId();
  const focus = useDraftFocus(dialog, !picker && !discard);
  const placement = draft.placement(tree, completed);
  const PlacementIcon = placement.column === 'locked' ? StepIcons.rowLocked : StepIcons.rowUpNext;
  const kinds = StepDraft.kinds(legend);

  useEffect(() => {
    if (draft === stored) return;
    setDraft(draft);
    request.current = null;
    setFailed(false);
  }, [draft, stored]);

  const cancel = () => {
    if (draft.dirty) { setDiscard(true); return; }
    track('roadmap_board_create', { step: 'cancel' });
    onClose();
  };
  const editing = () => { setFailed(false); request.current = null; name.current.focus(); };
  const change = (patch) => { setDraft(draft.with(patch)); request.current = null; setFailed(false); };
  const create = (retry = false) => {
    const errors = draft.validate();
    setNameError(errors.name);
    if (errors.name) { name.current.focus(); return; }
    if (retry) track('roadmap_board_create', { step: 'retry' });
    request.current ??= draft.toCreateRequest(tree);
    if (onCreate(request.current).ok) { onClose(); return; }
    track('roadmap_board_create', { step: 'failed' });
    setFailed(true);
  };
  const onKeyDown = (event) => {
    if (picker || discard) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    focus(event);
  };
  return (
    <div style={viewport} className={`st-board-composer-layer ${phone ? 'is-phone' : 'is-wide'}`} onKeyDown={onKeyDown}>
      {!phone && <div className="st-board-composer-scrim" aria-hidden onClick={() => {
        if (discard) return;
        if (picker) { track('roadmap_board_picker', { step: 'cancel' }); setPicker(false); return; }
        cancel();
      }} />}
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal={!picker && !discard ? 'true' : undefined} aria-labelledby={titleId}
        inert={picker || discard ? '' : undefined} className="st-board-composer">
        <header className="st-board-draft-heading">
          {phone && <button className="st-board-draft-cancel" type="button" onClick={cancel}>{COMPOSER.cancel}</button>}
          <h2 id={titleId}>{COMPOSER.title}</h2>{phone && <span className="st-board-draft-balance" />}
        </header>
        <form className="st-board-composer-form" onSubmit={(event) => { event.preventDefault(); create(failed); }}>
          <div className="st-board-composer-scroll" tabIndex={-1}>
            {failed && !phone && <div className="st-board-composer-failure" role="alert"><AlertCircle size={20} aria-hidden /><span>{SAVE_FAILURE.body}</span></div>}
            <label className="st-board-draft-field" htmlFor={nameId}><span>{COMPOSER.name}</span>
              <input ref={name} id={nameId} aria-label={COMPOSER.name} value={draft.name} placeholder={COMPOSER.namePlaceholder} autoComplete="off"
                aria-invalid={!!nameError} aria-describedby={nameError ? errorId : undefined}
                onChange={(event) => { change({ name: event.target.value }); if (nameError) setNameError(null); }} />
              {nameError && <span className="st-board-draft-name-error" id={errorId}>{nameError}</span>}
            </label>
            <label className="st-board-draft-field" htmlFor={descriptionId}><span>{COMPOSER.description}</span>
              <textarea id={descriptionId} value={draft.description} placeholder={COMPOSER.descriptionPlaceholder} onChange={(event) => change({ description: event.target.value })} />
            </label>
            <div className="st-board-draft-kind"><span>{COMPOSER.kind}</span><div role="radiogroup" aria-label={COMPOSER.kind}>
              {kinds.map((kind) => <button key={kind.hue} type="button" role="radio" aria-checked={draft.color === kind.hue}
                tabIndex={draft.color === kind.hue ? 0 : -1} onKeyDown={(event) => {
                  const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                  if (!direction) return;
                  event.preventDefault();
                  const index = kinds.findIndex((choice) => choice.hue === kind.hue);
                  const nextIndex = (index + direction + kinds.length) % kinds.length;
                  change({ color: kinds[nextIndex].hue });
                  event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[nextIndex].focus();
                }} className="st-board-draft-kind-choice" style={{ '--draft-kind': KIND_CSS[kind.hue].base, '--draft-kind-ring': KIND_CSS[kind.hue].ring }}
                onClick={() => change({ color: kind.hue })}>
                <span><i aria-hidden />{kind.label}{draft.color === kind.hue && <Check size={14} strokeWidth={2} aria-hidden />}</span>
              </button>)}
            </div></div>
            <button type="button" className="st-board-draft-needs" aria-haspopup="dialog" aria-expanded={picker} onClick={() => { track('roadmap_board_picker', { step: 'open' }); setPicker(true); }}>
              <strong>{COMPOSER.prerequisites}</strong><span>{prerequisiteNames(draft.prerequisites.map((id) => tree.nodesById.get(id).label)) || COMPOSER.none}</span><ChevronDown size={16} aria-hidden />
            </button>
            <div className="st-board-draft-placement" role="status"><strong><PlacementIcon />{COLUMN_TITLES[placement.column]}</strong><span>{placement.body}</span></div>
          </div>
          <footer className="st-board-composer-actions">
            {failed && phone && <p role="alert">{SAVE_FAILURE.body}</p>}
            <div>{failed ? <><Button variant={phone ? 'ghost' : 'secondary'} onClick={editing}>{SAVE_FAILURE.keepEditing}</Button><Button size={phone ? 'lg' : 'md'} type="submit">{SAVE_FAILURE.retry}</Button></>
              : <>{!phone && <Button variant="secondary" onClick={cancel}>{COMPOSER.cancel}</Button>}<Button size={phone ? 'lg' : 'md'} full={phone} type="submit">{COMPOSER.create}</Button></>}</div>
          </footer>
        </form>
      </section>
      {picker && <PrerequisitePicker tree={tree} completed={completed} draft={draft} band={band}
        onCancel={() => setPicker(false)} onApply={(prerequisites) => { change({ prerequisites }); setPicker(false); }} />}
      {discard && <DiscardDraft phone={phone} onKeep={() => setDiscard(false)} onDiscard={() => { track('roadmap_board_create', { step: 'discard' }); onClose(); }} />}
    </div>
  );
}

function DiscardDraft({ phone, onKeep, onDiscard }) {
  const dialog = useRef(null);
  const titleId = useId();
  const focus = useDraftFocus(dialog, true);
  return <div className="st-board-discard-layer">
    <div className="st-board-composer-scrim" aria-hidden onClick={onKeep} />
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="st-board-discard" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onKeep(); return; }
      focus(event);
    }}>
      <h2 id={titleId}>{DISCARD_DRAFT.title}</h2><p>{DISCARD_DRAFT.body}</p>
      <div><Button variant="secondary" size={phone ? 'lg' : 'md'} onClick={onKeep}>{DISCARD_DRAFT.keepEditing}</Button><Button variant="danger" size={phone ? 'lg' : 'md'} onClick={onDiscard}>{DISCARD_DRAFT.discard}</Button></div>
    </section>
  </div>;
}
