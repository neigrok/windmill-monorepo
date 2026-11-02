import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { NODE_COLOR_NAMES } from '../theme.js';
import { kindOptions } from '../model/Legend.js';
import { PrerequisiteChoices, StepDraft } from './StepDraft.js';
import { PrerequisitePicker } from './PrerequisitePicker.jsx';
import { KindChoice } from './BoardControls.jsx';
import { coverBeneath } from './BoardView.jsx';
import { useComposerFocus } from './composerFocus.js';
import { StepIcons } from './StepIcons.jsx';
import { COLUMN_TITLES, COMPOSER, DISCARD_DRAFT, EDIT_STEP, SAVE_FAILURE, STEP_DETAIL, prerequisiteNames } from './copy.js';
import './composer.css';

const PALETTE = { nodes: NODE_COLOR_NAMES.map((color) => ({ color })) };

export function useComposerViewport(phone) {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    visible: typeof window === 'undefined' || !window.visualViewport ? null : {
      top: window.visualViewport.offsetTop,
      left: window.visualViewport.offsetLeft,
      width: window.visualViewport.width,
      height: window.visualViewport.height,
    },
  }));
  useEffect(() => {
    const visible = window.visualViewport;
    const resize = () => setViewport({
      width: window.innerWidth,
      visible: visible ? {
        top: visible.offsetTop,
        left: visible.offsetLeft,
        width: visible.width,
        height: visible.height,
      } : null,
    });
    resize();
    window.addEventListener('resize', resize);
    visible?.addEventListener('resize', resize);
    visible?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      visible?.removeEventListener('resize', resize);
      visible?.removeEventListener('scroll', resize);
    };
  }, []);
  return {
    panelFits: viewport.width >= 1440,
    style: phone && viewport.visible ? { position: 'fixed', ...viewport.visible } : undefined,
  };
}

export function StepComposer({ tree, completed, legend, band, editing, onCreate, onEdit, onClose }) {
  const phone = band === 'phone';
  const mode = editing ? 'edit' : 'create';
  const eventName = editing ? 'roadmap_board_edit' : 'roadmap_board_create';
  const viewport = useComposerViewport(phone);
  const [stored, setDraft] = useState(() => editing ? StepDraft.forStep(tree.nodesById.get(editing)) : new StepDraft());
  const [picker, setPicker] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nameError, setNameError] = useState(null);
  const request = useRef(null);
  const dialog = useRef(null);
  const layer = useRef(null);
  const revalidationReported = useRef(null);
  const name = useRef(null);
  const needs = useRef(null);
  const returnToNeeds = useRef(false);
  const titleId = useId();
  const pickerTitleId = useId();
  const nameId = useId();
  const errorId = useId();
  const descriptionId = useId();
  const focus = useComposerFocus(dialog, !discard);
  const draft = stored.reconcile(tree);
  const choices = tree.nodes.length > 0 ? picker?.reconcile(tree, completed) ?? null : null;
  const pickerOpen = choices !== null;
  const pickerLayout = phone ? 'phone' : viewport.panelFits ? 'panel' : 'page';
  const pickerPage = pickerOpen && pickerLayout !== 'panel';
  const placement = draft.placement(tree, completed);
  const PlacementIcon = { locked: StepIcons.rowLocked, upNext: StepIcons.rowUpNext, done: StepIcons.rowDone }[placement.column];
  const kinds = kindOptions(PALETTE, legend);
  const prerequisiteLabels = draft.prerequisites.map((id) => {
    const label = tree.nodesById.get(id).label;
    return label?.trim() ? label : STEP_DETAIL.unnamed;
  });

  if (draft !== stored) {
    setDraft(draft);
    request.current = null;
    setFailed(false);
  }
  if (choices !== picker) {
    setPicker(choices);
    if (!choices) returnToNeeds.current = true;
  }

  useLayoutEffect(() => coverBeneath(layer.current), []);

  const revalidation = choices?.revalidated.map((row) => row.id).join(',') || null;
  useEffect(() => {
    if (revalidation && revalidation !== revalidationReported.current) {
      track('roadmap_board_picker', { step: 'revalidated', mode });
    }
    revalidationReported.current = revalidation;
  }, [revalidation, mode]);

  useLayoutEffect(() => {
    if (pickerOpen || !returnToNeeds.current) return;
    returnToNeeds.current = false;
    needs.current?.focus({ preventScroll: true });
  }, [pickerOpen]);

  const closePicker = () => {
    returnToNeeds.current = true;
    setPicker(null);
  };
  const cancel = () => {
    if (draft.dirty) {
      setDiscard(true);
      return;
    }
    track(eventName, { step: 'cancel' });
    onClose();
  };
  const change = (patch) => {
    setDraft(draft.with(patch));
    request.current = null;
    setFailed(false);
  };
  const save = () => {
    if (editing && !draft.dirty) {
      track(eventName, { step: 'unchanged' });
      onClose();
      return;
    }
    const errors = draft.validate();
    setNameError(errors.name);
    if (errors.name) {
      name.current.focus();
      return;
    }
    if (failed) track(eventName, { step: 'retry' });
    request.current ??= editing ? draft.toEditRequest(tree) : draft.toCreateRequest(tree);
    const result = editing ? onEdit(request.current) : onCreate(request.current);
    if (result.ok) {
      onClose();
      return;
    }
    track(eventName, { step: 'failed' });
    setFailed(true);
  };
  const dismiss = () => {
    if (discard) return;
    if (pickerOpen) {
      track('roadmap_board_picker', { step: 'cancel', mode });
      closePicker();
      return;
    }
    cancel();
  };
  const onKeyDown = (event) => {
    if (discard) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    focus(event);
  };
  const pickerView = pickerOpen && (
    <PrerequisitePicker
      choices={choices}
      mode={mode}
      onChoices={setPicker}
      draft={draft}
      layout={pickerLayout}
      headingId={pickerTitleId}
      onCancel={closePicker}
      onApply={(prerequisites) => {
        change({ prerequisites });
        closePicker();
      }}
    />
  );
  const form = (
    <div className="st-board-composer-draft" inert={pickerOpen ? '' : undefined}>
      <header className="st-board-draft-heading">
        {phone && (
          <button className="st-board-draft-cancel" type="button" onClick={cancel}>{COMPOSER.cancel}</button>
        )}
        <h2 id={titleId}>{editing ? EDIT_STEP.title : COMPOSER.title}</h2>
        {phone && <span className="st-board-draft-balance" />}
      </header>
      <form
        className="st-board-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="st-board-composer-scroll" tabIndex={-1}>
          {nameError && <p className="st-board-draft-name-error" id={errorId}>{nameError}</p>}
          {failed && !phone && (
            <div className="st-board-composer-failure" role="alert">
              <AlertCircle size={20} aria-hidden />
              <span>{SAVE_FAILURE.body}</span>
            </div>
          )}
          <label className="st-board-draft-field" htmlFor={nameId}>
            <span>{COMPOSER.name}</span>
            <input
              ref={name}
              id={nameId}
              value={draft.name}
              placeholder={COMPOSER.namePlaceholder}
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? errorId : undefined}
              onChange={(event) => {
                change({ name: event.target.value });
                if (nameError) setNameError(null);
              }}
            />
          </label>
          <label className="st-board-draft-field" htmlFor={descriptionId}>
            <span>{COMPOSER.description}</span>
            <textarea
              id={descriptionId}
              value={draft.description}
              placeholder={COMPOSER.descriptionPlaceholder}
              onChange={(event) => change({ description: event.target.value })}
            />
          </label>
          <div className="st-board-draft-kind">
            <span>{COMPOSER.kind}</span>
            <KindChoice kinds={kinds} value={draft.color} onChoose={(color) => change({ color })} label={COMPOSER.kind} />
          </div>
          <button
            ref={needs}
            type="button"
            className="st-board-draft-needs"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-disabled={tree.nodes.length === 0}
            onClick={() => {
              if (tree.nodes.length === 0) return;
              track('roadmap_board_picker', { step: 'open', mode });
              setPicker(new PrerequisiteChoices(tree, completed, { selected: draft.prerequisites, editing }));
            }}
          >
            <strong>{COMPOSER.prerequisites}</strong>
            <span>{prerequisiteNames(prerequisiteLabels) || COMPOSER.none}</span>
            <ChevronDown size={16} aria-hidden />
          </button>
          <div className="st-board-draft-placement" role="status">
            <strong><PlacementIcon />{COLUMN_TITLES[placement.column]}</strong>
            {placement.body && <span>{placement.body}</span>}
          </div>
        </div>
        <footer className="st-board-composer-actions">
          {failed && phone && <p role="alert">{SAVE_FAILURE.body}</p>}
          <div>
            {failed ? (
              <>
                <Button
                  variant={phone ? 'ghost' : 'secondary'}
                  onClick={() => {
                    setFailed(false);
                    request.current = null;
                    name.current.focus();
                  }}
                >
                  {SAVE_FAILURE.keepEditing}
                </Button>
                <Button size={phone ? 'lg' : 'md'} type="submit">{SAVE_FAILURE.retry}</Button>
              </>
            ) : (
              <>
                {!phone && <Button variant="secondary" onClick={cancel}>{COMPOSER.cancel}</Button>}
                <Button size={phone ? 'lg' : 'md'} full={phone} type="submit">{editing ? EDIT_STEP.save : COMPOSER.create}</Button>
              </>
            )}
          </div>
        </footer>
      </form>
    </div>
  );

  return createPortal(
    <div
      ref={layer}
      style={viewport.style}
      className={`st-board-composer-layer ${phone ? 'is-phone' : 'is-wide'}`}
      onKeyDown={onKeyDown}
    >
      {!phone && <div className="st-board-composer-scrim" aria-hidden onClick={dismiss} />}
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal={discard ? undefined : 'true'}
        aria-labelledby={pickerOpen ? pickerTitleId : titleId}
        inert={discard ? '' : undefined}
        className={`st-board-composer ${pickerPage ? 'is-picker-page' : ''}`}
      >
        {pickerPage ? pickerView : <>{form}{pickerView}</>}
      </section>
      {discard && (
        <DiscardDraft
          phone={phone}
          onKeep={() => setDiscard(false)}
          onDiscard={() => {
            track(eventName, { step: 'discard' });
            onClose();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

export function DiscardDraft({ phone, onKeep, onDiscard }) {
  const dialog = useRef(null);
  const titleId = useId();
  const focus = useComposerFocus(dialog);
  return (
    <div className="st-board-discard-layer">
      <div className="st-board-composer-scrim" aria-hidden onClick={onKeep} />
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="st-board-discard"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onKeep();
            return;
          }
          focus(event);
        }}
      >
        <h2 id={titleId}>{DISCARD_DRAFT.title}</h2>
        <p>{DISCARD_DRAFT.body}</p>
        <div>
          <Button variant="secondary" size={phone ? 'lg' : 'md'} onClick={onKeep}>{DISCARD_DRAFT.keepEditing}</Button>
          <Button variant="danger" size={phone ? 'lg' : 'md'} onClick={onDiscard}>{DISCARD_DRAFT.discard}</Button>
        </div>
      </section>
    </div>
  );
}
