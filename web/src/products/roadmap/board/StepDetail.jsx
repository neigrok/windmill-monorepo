// A step opened from the Board: the pushed page below 744px, the modal from 744px. Both frames arrange one body — the
// identity, the status row, what the step needs and opens, the workspace and its history — and one set of verbs.
// Complete and Reset act in place: the status row flips with an inline Undo for the hold window and a line names what
// moved; nothing here toasts. While open the layer makes everything beneath it inert and keeps Tab inside; closing hands
// focus back to the card the visit began on. Measures from 01.04–01.11, 07.01–07.06 (phone), 02.01–02.04, 03.01–03.10
// and 05.06 (from 744px).

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import './detail.css';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { NodeWorkspace, SAFE_URL } from '../ui/tree/NodeWorkspace.jsx';
import { EventRow } from '../activity/EventRow.jsx';
import { coverBeneath } from './BoardView.jsx';
import { StepFacts, STEP_SECTIONS, offersCompletion } from './StepFacts.js';
import { StepIcons } from './StepIcons.jsx';
import { StepModal } from './StepModal.jsx';
import { StepPage } from './StepPage.jsx';
import {
  COLUMN_TITLES, LABELS, LINK_COPIED, STATE_WORDS, STEP_DETAIL,
  completedOutcome, lockedStatus, prerequisitesTally, resetOutcome, resetPreview,
} from './copy.js';

const UNDO_HOLD_MS = 6000;
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const BRAND_CHECKS = { base: 'var(--color-brand)', ring: 'var(--color-brand)' };
const ROW_GLYPHS = { done: StepIcons.rowDone, upNext: StepIcons.rowUpNext, locked: StepIcons.rowLocked };
const STATUS_GLYPHS = { done: StepIcons.statusDone, upNext: StepIcons.statusUpNext, locked: StepIcons.statusLocked };
const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

const titleOf = (step) => step.label?.trim() || STEP_DETAIL.unnamed;

// `address` is the open step and how it was reached (stepAddress.js). Without `editable` the reader gets the overview and
// the menu alone: no sections, no Complete, no Delete.
export function StepDetail({
  tree,
  completed,
  completedAt,
  address,
  breakpoint,
  roadmapTitle,
  editable = false,
  deletable = false,
  stepLink = null,
  workspace,
  workspaceActions,
  history = [],
  onOpenStep,
  onBack,
  onClose,
  onComplete,
  onReset,
  onOpenInGraph,
  onDelete,
  onNotify,
}) {
  const { id, trail, door } = address;
  const surface = breakpoint === 'phone' ? 'page' : 'modal';
  const facts = useMemo(() => new StepFacts(tree, { completed, completedAt }, id), [tree, completed, completedAt, id]);
  const layerRef = useRef(null);
  const originRef = useRef(null);
  const titleId = useId();
  const sectionsId = useId();
  const [stepShown, setStepShown] = useState(id);
  const [section, setSection] = useState('overview');
  const [outcome, setOutcome] = useState(null);
  originRef.current = trail[0];

  if (stepShown !== id) {
    setStepShown(id);
    setSection('overview');
    setOutcome(null);
  }

  useEffect(() => {
    const uncover = coverBeneath(layerRef.current);
    return () => {
      uncover();
      const returnTo = originRef.current;
      requestAnimationFrame(() => {
        document.querySelector(`.st-view-layer--board.is-active .st-board-card[data-step-id="${CSS.escape(returnTo)}"]`)?.focus();
      });
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    (layer.matches('[role="dialog"]') ? layer : layer.querySelector('[role="dialog"]')).focus();
    if (door !== 'back') track('roadmap_board_step_open', { surface, column: facts.column, door });
  }, [id, door]);

  useEffect(() => {
    if (!outcome?.undoable) return undefined;
    const settle = setTimeout(() => setOutcome((current) => current && { ...current, undoable: false }), UNDO_HOLD_MS);
    return () => clearTimeout(settle);
  }, [outcome?.undoable, outcome?.kind]);

  const act = (action, extra = {}) => track('roadmap_board_step_action', { surface, action, ...extra });

  const complete = (action) => {
    onComplete(id);
    setOutcome({ kind: 'complete', line: completedOutcome({ unlocked: facts.opens.map(titleOf) }), undoable: true });
    act(action);
  };

  const reset = () => {
    onReset(id);
    setOutcome({ kind: 'reset', line: resetOutcome({ relocked: facts.relocks }), undoable: true });
    act('reset');
  };

  const undo = () => {
    if (outcome.kind === 'complete') onReset(id);
    else onComplete(id);
    setOutcome(null);
    act('undo');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(stepLink);
      onNotify(LINK_COPIED);
      act('copyLink', { outcome: 'ok' });
    } catch {
      act('copyLink', { outcome: 'failed' });
    }
  };

  const menuItems = [
    stepLink && { label: STEP_DETAIL.copyLink, icon: StepIcons.copyLink, run: copyLink },
    { label: STEP_DETAIL.openInGraph, icon: StepIcons.graph, run: () => { act('openInGraph'); onOpenInGraph(id); } },
    editable && deletable && { label: STEP_DETAIL.deleteStep, icon: StepIcons.trash, danger: true, run: () => { act('delete'); onDelete(id); } },
  ].filter(Boolean);

  // Escape leaves the way the frame does (the page goes back a step, the modal closes); Tab wraps inside the layer.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (surface === 'page') onBack();
      else onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...layerRef.current.querySelectorAll(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    if (stops.length === 0) return;
    const [first, last] = [stops[0], stops[stops.length - 1]];
    const outside = !stops.includes(document.activeElement);
    if (event.shiftKey && (document.activeElement === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const offer = editable && section === 'workspace' && offersCompletion(workspace, facts.column)
    ? <SubtaskOffer onComplete={() => complete('completeFromSubtasks')} />
    : null;
  const shownSection = editable ? section : 'overview';
  const content = (
    <div id={`${sectionsId}-${shownSection}`} role={editable ? 'tabpanel' : undefined} aria-labelledby={editable ? `${sectionsId}-tab-${shownSection}` : undefined} className="st-board-step-panel">
      {shownSection === 'overview' && (
        <Overview facts={facts} outcome={outcome} marksNeeds={surface === 'page'} onUndo={undo} onOpenStep={onOpenStep} />
      )}
      {shownSection === 'workspace' && (
        <NodeWorkspace
          nodeId={id}
          workspace={workspace}
          hue={BRAND_CHECKS}
          checklistLabels={{ heading: STEP_DETAIL.subtasks, add: STEP_DETAIL.addSubtask }}
          {...workspaceActions}
        />
      )}
      {shownSection === 'history' && (
        <div className="st-board-step-history">
          {history.map((event) => <EventRow key={event.id} event={event} node={null} now={Date.now()} />)}
        </div>
      )}
    </div>
  );

  const frame = {
    layerRef,
    labelledBy: titleId,
    onKeyDown,
    identity: <StepIdentity step={facts.step} titleId={titleId} />,
    menu: <StepMenu items={menuItems} />,
    sections: editable ? <StepSections idPrefix={sectionsId} section={section} onSection={setSection} /> : null,
    content,
    offer,
    actions: editable && facts.column !== 'locked' ? <StepActions facts={facts} phone={surface === 'page'} onComplete={() => complete('complete')} onReset={reset} /> : null,
  };

  if (surface === 'page') {
    const previous = trail.length > 1 ? tree.nodesById.get(trail[trail.length - 2]) : null;
    return <StepPage {...frame} backLabel={previous ? titleOf(previous) : roadmapTitle} onBack={onBack} />;
  }
  return <StepModal {...frame} onClose={onClose} />;
}

function StepIdentity({ step, titleId }) {
  const kind = KIND_CSS[step.color] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  return (
    <div className="st-board-step-identity" style={{ '--st-board-step-rail': kind.base }}>
      <span className="st-board-step-identity-rail" aria-hidden />
      <h2 id={titleId} className="st-board-step-identity-title">{titleOf(step)}</h2>
    </div>
  );
}

// The page marks a locked step's unmet needs with their column (01.07); the modal lists them plainly (03.07).
function Overview({ facts, outcome, marksNeeds, onUndo, onOpenStep }) {
  const description = facts.step.description?.trim() ?? '';
  const links = (facts.step.links ?? []).filter((link) => SAFE_URL.test(link.url));
  const needing = marksNeeds && facts.column === 'locked';
  return (
    <>
      {description && <p className="st-board-step-description">{description}</p>}
      <StatusRow facts={facts} outcome={outcome} onUndo={onUndo} />
      {links.length > 0 && (
        <div className="st-board-step-links">
          <h3 className="st-board-step-heading">{STEP_DETAIL.stepLinks}</h3>
          {links.map((link, index) => (
            <a key={`${index}-${link.url}`} className="st-board-step-link" href={link.url} target="_blank" rel="noopener noreferrer">
              <span className="st-board-step-link-label">{link.label || link.url}</span>
              <StepIcons.external />
            </a>
          ))}
        </div>
      )}
      {facts.prerequisites.length > 0 && (
        <section className="st-board-step-relations">
          <h3 className="st-board-step-heading">
            <span>{STEP_DETAIL.prerequisites}</span>
            <span className="st-board-step-heading-count">{prerequisitesTally({ done: facts.prerequisitesDone, total: facts.prerequisites.length })}</span>
          </h3>
          {facts.prerequisites.map((related) => (
            <RelationRow key={related.id} related={related} need={needing && related.column !== 'done'} onOpen={onOpenStep} />
          ))}
        </section>
      )}
      {facts.unlocks.length > 0 && (
        <section className="st-board-step-relations">
          <h3 className="st-board-step-heading">
            <span>{STEP_DETAIL.unlocks}</span>
            <span className="st-board-step-heading-count">{facts.unlocks.length.toLocaleString('en-US')}</span>
          </h3>
          {facts.unlocks.map((related) => <RelationRow key={related.id} related={related} onOpen={onOpenStep} />)}
        </section>
      )}
    </>
  );
}

// The step's column with a leading glyph; after Complete or Reset, Undo for the hold window and a line naming what moved.
function StatusRow({ facts, outcome, onUndo }) {
  const Glyph = STATUS_GLYPHS[facts.column];
  const label = facts.column === 'locked' ? lockedStatus({ toGo: facts.toGo }) : COLUMN_TITLES[facts.column];
  return (
    <div className={`st-board-step-status st-board-step-status--${facts.column}`}>
      <div className="st-board-step-status-row">
        <span className="st-board-step-status-glyph"><Glyph /></span>
        <span className="st-board-step-status-label">{label}</span>
        {outcome?.undoable && (
          <>
            <span className="st-board-step-status-dot" aria-hidden>·</span>
            <button type="button" className="st-board-step-undo" onClick={onUndo}>{LABELS.undo}</button>
          </>
        )}
      </div>
      <p className="st-board-step-outcome" role="status">{outcome?.line ?? ''}</p>
    </div>
  );
}

// A step this one needs or opens; a locked step's unmet needs carry their own column, since they are the way through.
function RelationRow({ related, need = false, onOpen }) {
  const Glyph = ROW_GLYPHS[related.column];
  return (
    <button
      type="button"
      className={`st-board-step-row${need ? ' st-board-step-row--need' : ''}`}
      aria-label={`${titleOf(related.step)}, ${STATE_WORDS[related.column]}`}
      onClick={() => onOpen(related.id)}
    >
      <span className={`st-board-step-row-glyph st-board-step-row-glyph--${related.column}`}><Glyph /></span>
      <span className="st-board-step-row-label">{titleOf(related.step)}</span>
      {need && <span className="st-board-step-row-state">{COLUMN_TITLES[related.column]}</span>}
      <span className="st-board-step-row-chevron"><StepIcons.chevron /></span>
    </button>
  );
}

function StepSections({ idPrefix, section, onSection }) {
  const tabs = useRef({});
  const onKeyDown = (event) => {
    const index = STEP_SECTIONS.indexOf(section);
    const next = event.key === 'Home' ? STEP_SECTIONS[0]
      : event.key === 'End' ? STEP_SECTIONS[STEP_SECTIONS.length - 1]
        : event.key in ARROW_STEPS ? STEP_SECTIONS[(index + ARROW_STEPS[event.key] + STEP_SECTIONS.length) % STEP_SECTIONS.length]
          : null;
    if (next === null) return;
    event.preventDefault();
    onSection(next);
    tabs.current[next].focus();
  };
  return (
    <div className="st-board-step-sections" role="tablist" onKeyDown={onKeyDown}>
      {STEP_SECTIONS.map((name) => (
        <button
          key={name}
          ref={(node) => { tabs.current[name] = node; }}
          id={`${idPrefix}-tab-${name}`}
          type="button"
          role="tab"
          className="st-board-step-section"
          aria-selected={name === section}
          aria-controls={`${idPrefix}-${name}`}
          tabIndex={name === section ? 0 : -1}
          onClick={() => onSection(name)}
        >
          <span className="st-board-step-section-surface">{STEP_DETAIL.sections[name]}</span>
        </button>
      ))}
    </div>
  );
}

// Up next offers Complete; Done offers Reset, secondary, previewing what it returns to Locked.
function StepActions({ facts, phone, onComplete, onReset }) {
  const [previewing, setPreviewing] = useState(false);
  if (facts.column === 'upNext') {
    return (
      <div className="st-board-step-buttons">
        <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={onComplete}>{STEP_DETAIL.complete}</button>
      </div>
    );
  }
  const preview = previewing ? resetPreview({ relocked: facts.relocks }) : null;
  return (
    <>
      {preview && <p className="st-board-step-preview">{preview}</p>}
      <div
        className="st-board-step-buttons"
        onPointerEnter={phone ? undefined : () => setPreviewing(true)}
        onPointerLeave={() => setPreviewing(false)}
        onFocus={() => setPreviewing(true)}
        onBlur={() => setPreviewing(false)}
      >
        <button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={onReset}>{STEP_DETAIL.reset}</button>
      </div>
    </>
  );
}

function SubtaskOffer({ onComplete }) {
  return (
    <div className="st-board-step-offer">
      <span className="st-board-step-offer-glyph"><StepIcons.offer /></span>
      <span className="st-board-step-offer-body">{STEP_DETAIL.subtaskOffer.body}</span>
      <button type="button" className="st-board-step-offer-action" onClick={onComplete}>{STEP_DETAIL.subtaskOffer.action}</button>
    </div>
  );
}

// The ⋯ popover: it closes on a choice, on Escape (focus back on ⋯) and on a pointer landing outside it.
function StepMenu({ items }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    box.current.querySelector('[role="menuitem"]')?.focus();
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      opener.current.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const choices = [...box.current.querySelectorAll('[role="menuitem"]')];
    choices[(choices.indexOf(document.activeElement) + step + choices.length) % choices.length].focus();
  };

  return (
    <div className="st-board-step-menu" ref={box}>
      <button
        ref={opener}
        type="button"
        className="st-board-step-icon-button"
        aria-label={STEP_DETAIL.more}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <StepIcons.more />
      </button>
      {open && (
        <div className="st-board-step-menu-list" role="menu" onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`st-board-step-menu-item${item.danger ? ' st-board-step-menu-item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                opener.current.focus();
                item.run();
              }}
            >
              <item.icon />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
