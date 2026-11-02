import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS, NODE_COLOR_NAMES } from '../theme.js';
import { kindOptions } from '../model/Legend.js';
import { PrerequisiteChoices, StepDraft } from './StepDraft.js';
import { PrerequisitePicker } from './PrerequisitePicker.jsx';
import { useComposerFocus } from './composerFocus.js';
import { StepIcons } from './StepIcons.jsx';
import { COLUMN_TITLES, COMPOSER, DISCARD_DRAFT, SAVE_FAILURE, STEP_DETAIL, prerequisiteNames } from './copy.js';
import './composer.css';

const PALETTE = { nodes: NODE_COLOR_NAMES.map((color) => ({ color })) };

function useComposerViewport(phone) {
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

export function StepComposer({ tree, completed, legend, band, onCreate, onClose }) {
  const phone = band === 'phone';
  const viewport = useComposerViewport(phone);
  const [stored, setDraft] = useState(() => new StepDraft());
  const [picker, setPicker] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nameError, setNameError] = useState(null);
  const request = useRef(null);
  const dialog = useRef(null);
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
  const PlacementIcon = placement.column === 'locked' ? StepIcons.rowLocked : StepIcons.rowUpNext;
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
    track('roadmap_board_create', { step: 'cancel' });
    onClose();
  };
  const editing = () => {
    setFailed(false);
    request.current = null;
    name.current.focus();
  };
  const change = (patch) => {
    setDraft(draft.with(patch));
    request.current = null;
    setFailed(false);
  };
  const create = () => {
    const errors = draft.validate();
    setNameError(errors.name);
    if (errors.name) {
      name.current.focus();
      return;
    }
    if (failed) track('roadmap_board_create', { step: 'retry' });
    request.current ??= draft.toCreateRequest(tree);
    if (onCreate(request.current).ok) {
      onClose();
      return;
    }
    track('roadmap_board_create', { step: 'failed' });
    setFailed(true);
  };
  const dismiss = () => {
    if (discard) return;
    if (pickerOpen) {
      track('roadmap_board_picker', { step: 'cancel' });
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
        <h2 id={titleId}>{COMPOSER.title}</h2>
        {phone && <span className="st-board-draft-balance" />}
      </header>
      <form
        className="st-board-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
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
            <div role="radiogroup" aria-label={COMPOSER.kind}>
              {kinds.map((kind) => (
                <button
                  key={kind.hue}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === kind.hue}
                  tabIndex={draft.color === kind.hue ? 0 : -1}
                  className="st-board-draft-kind-choice"
                  style={{ '--draft-kind': KIND_CSS[kind.hue].base, '--draft-kind-ring': KIND_CSS[kind.hue].ring }}
                  onClick={() => change({ color: kind.hue })}
                  onKeyDown={(event) => {
                    const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                    if (!direction) return;
                    event.preventDefault();
                    const index = kinds.findIndex((choice) => choice.hue === kind.hue);
                    const nextIndex = (index + direction + kinds.length) % kinds.length;
                    change({ color: kinds[nextIndex].hue });
                    event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[nextIndex].focus();
                  }}
                >
                  <span>
                    <i aria-hidden />
                    {kind.label}
                    {draft.color === kind.hue && <Check size={14} strokeWidth={2} aria-hidden />}
                  </span>
                </button>
              ))}
            </div>
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
              track('roadmap_board_picker', { step: 'open' });
              setPicker(new PrerequisiteChoices(tree, completed, { selected: draft.prerequisites }));
            }}
          >
            <strong>{COMPOSER.prerequisites}</strong>
            <span>{prerequisiteNames(prerequisiteLabels) || COMPOSER.none}</span>
            <ChevronDown size={16} aria-hidden />
          </button>
          <div className="st-board-draft-placement" role="status">
            <strong><PlacementIcon />{COLUMN_TITLES[placement.column]}</strong>
            <span>{placement.body}</span>
          </div>
        </div>
        <footer className="st-board-composer-actions">
          {failed && phone && <p role="alert">{SAVE_FAILURE.body}</p>}
          <div>
            {failed ? (
              <>
                <Button variant={phone ? 'ghost' : 'secondary'} onClick={editing}>{SAVE_FAILURE.keepEditing}</Button>
                <Button size={phone ? 'lg' : 'md'} type="submit">{SAVE_FAILURE.retry}</Button>
              </>
            ) : (
              <>
                {!phone && <Button variant="secondary" onClick={cancel}>{COMPOSER.cancel}</Button>}
                <Button size={phone ? 'lg' : 'md'} full={phone} type="submit">{COMPOSER.create}</Button>
              </>
            )}
          </div>
        </footer>
      </form>
    </div>
  );

  return (
    <div
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
            track('roadmap_board_create', { step: 'discard' });
            onClose();
          }}
        />
      )}
    </div>
  );
}

function DiscardDraft({ phone, onKeep, onDiscard }) {
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
