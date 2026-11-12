// Roadmap step detail: a pushed page below 744px and a modal otherwise.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './detail.css';
import { track } from '../../../telemetry/beacon.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { hueOf } from '../theme.js';
import { SAFE_URL } from '../graph/tree/NodeWorkspace.jsx';
import { StepWorkspace, StepHistory } from './StepWorkspace.jsx';
import { deletionCost } from '../board/acts.js';
import { StepFacts, STEP_SECTIONS, offersCompletion, titleOf } from './StepFacts.js';
import { Sheet, handleMenuKey } from '../board/BoardControls.jsx';
import { treeAttachment } from '../model/UnlockRules.js';
import { StepIcons } from './StepIcons.jsx';
import { TreePicker } from './TreePicker.jsx';
import { OpeningBar, OpeningGlyph } from '../OpeningMarks.jsx';
import { useTreeDoor } from '../room/useTreeVisit.js';
import { coverBeneath, DetailFocusContext } from './composerFocus.js';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { boardFocusTarget } from '../board/traversal.js';
import './modal.css';
import './page.css';
import {
  COLUMN_TITLES, LABELS, deleteCostLine, LINK_COPIED, STATE_WORDS, STEP_DETAIL, TREE, WORKSPACE_EMPTY, checkedToast,
  DELETE_CONFIRM, deleteConfirm, backTo, completedOutcome, formatCount, lockedStatus, prerequisitesTally, resetOutcome, resetPreview,
  openTreeStated, treeBand, treeState, treeTitle,
} from '../copy.js';
import { t } from '../i18n/index.js';

const UNDO_HOLD_MS = 6000;
const ROW_GLYPHS = { done: StepIcons.rowDone, upNext: StepIcons.rowUpNext, locked: StepIcons.rowLocked };
const STATUS_GLYPHS = { done: StepIcons.statusDone, upNext: StepIcons.statusUpNext, locked: StepIcons.statusLocked };
const TAB_STOP = '[data-column] [tabindex="0"], [data-column][tabindex="0"]';

// `address` is the open step and how it was reached (stepAddress.js). Without `editable` the reader gets the overview and
// the menu alone: no sections, no Complete, no Delete. `treeActs` is the holder's way to attach, change and detach the
// tree the step opens: `{ view, trees, set }`, or null where nobody may.
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
  onRestore,
  onOpenInGraph,
  onSelect,
  onViewBranch,
  onDelete,
  onDeletePrompt,
  onEdit,
  onNotify,
  treeActs = null,
}) {
  const { id, trail, door } = address;
  const surface = breakpoint === 'phone' ? 'page' : 'modal';
  const facts = useMemo(() => new StepFacts(tree, { completed, completedAt }, id), [tree, completed, completedAt, id]);
  const openTree = useTreeDoor(facts.step, 'step');
  const layerRef = useRef(null);
  const originRef = useRef(null);
  const deletedRef = useRef(null);
  const selectingRef = useRef(false);
  const leaveRef = useRef(null);
  const workspaceRef = useRef(null);
  const pinnedNoteRef = useRef(null);
  const editingRef = useRef(false);
  const treeControl = useRef(null);
  const closeTreePicker = useRef(null);
  const treeChanged = useRef(false);
  const titleId = useId();
  const pickerTitleId = useId();
  const sectionsId = useId();
  const [stepShown, setStepShown] = useState(id);
  const [section, setSection] = useState('overview');
  const [outcome, setOutcome] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [noteEditing, setNoteEditing] = useState(false);
  const [checked, setChecked] = useState(null);
  const [treePicker, setTreePicker] = useState(false);
  originRef.current = trail[0];
  leaveRef.current = surface === 'page' ? onBack : onClose;
  editingRef.current = noteEditing;

  if (stepShown !== id) {
    setStepShown(id);
    setSection('overview');
    setOutcome(null);
    setDeleting(false);
    setNoteEditing(false);
    setChecked(null);
    setTreePicker(false);
  }

  if (checked && !workspace?.subtasks?.some((item) => item.id === checked.id && item.done)) {
    setChecked(null);
  }

  const restoreDetailFocus = useCallback((openerRef) => {
    const restore = () => {
      const layer = layerRef.current;
      if (!layer || layer.closest('[inert]')) return;
      const opener = openerRef?.current;
      if (opener?.isConnected && !opener.closest('[inert]') && opener.getClientRects().length > 0) {
        opener.focus({ preventScroll: true });
        return;
      }
      if (editingRef.current) return;
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      const target = layer.querySelector('.st-board-step-status') ?? layer.querySelector('[role="dialog"]');
      target?.focus({ preventScroll: true });
    };
    if (openerRef) requestAnimationFrame(restore);
    else restore();
  }, []);
  const detailFocus = useMemo(() => ({ restore: restoreDetailFocus }), [restoreDetailFocus]);

  // The detail owns fallback focus; nested editors return to their opener reference first.
  useEffect(() => {
    const layer = layerRef.current;
    const uncover = coverBeneath(layer);
    const recover = () => {
      restoreDetailFocus(null);
    };
    const watcher = new MutationObserver(recover);
    watcher.observe(layer, { childList: true, subtree: true });
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.closest('[inert]')) return;
      if (closeTreePicker.current) {
        event.preventDefault();
        event.stopPropagation();
        closeTreePicker.current();
        return;
      }
      if (editingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        workspaceRef.current?.close();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      leaveRef.current();
    };
    document.addEventListener('keydown', escape);
    return () => {
      watcher.disconnect();
      document.removeEventListener('keydown', escape);
      uncover();
      const returnTo = originRef.current;
      requestAnimationFrame(() => {
        if (selectingRef.current) return;
        const board = document.querySelector('.st-view-layer--board.is-active');
        if (!board) return;
        const returningStop = () => {
          const target = boardFocusTarget(board, { excludeId: deletedRef.current });
          return target?.matches(TAB_STOP) ? target : null;
        };
        const target = boardFocusTarget(board, {
          preferredId: deletedRef.current === null ? returnTo : null,
          excludeId: deletedRef.current,
        });
        if (!target) return;
        target.focus();
        if (deletedRef.current === null || target.matches('.st-board-card')) return;
        const fallback = target;
        const waiting = new MutationObserver(() => {
          if (!board.isConnected || document.activeElement !== fallback) {
            waiting.disconnect();
            return;
          }
          const stop = returningStop();
          if (!stop || stop === fallback) return;
          waiting.disconnect();
          stop.focus();
        });
        fallback.addEventListener('blur', () => waiting.disconnect(), { once: true });
        waiting.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'class'] });
      });
    };
  }, [restoreDetailFocus]);

  useEffect(() => {
    if (layerRef.current.closest('[inert]') || editingRef.current) return;
    layerRef.current.querySelector('[role="dialog"]').focus();
  }, [id, surface]);

  useEffect(() => {
    if (door !== 'back') track('roadmap_board_step_open', { surface, column: facts.column, door });
  }, [id, door]);

  // A tree attached or detached here keeps its section in view while it settles: the row arrives once the room has read the tree.
  const treeFace = facts.opening?.face ?? null;
  useEffect(() => {
    if (!treeChanged.current || treePicker) return;
    if (treeFace !== 'unread') treeChanged.current = false;
    treeControl.current?.closest('section').scrollIntoView({ block: 'nearest' });
  }, [treeFace, treePicker]);

  useEffect(() => {
    if (!outcome?.undoable) return undefined;
    const settle = setTimeout(() => setOutcome((current) => current && { ...current, undoable: false }), UNDO_HOLD_MS);
    return () => clearTimeout(settle);
  }, [outcome?.undoable, outcome?.kind]);

  useEffect(() => {
    if (!checked) return undefined;
    const timer = setTimeout(() => setChecked(null), UNDO_HOLD_MS);
    return () => clearTimeout(timer);
  }, [checked]);

  const act = (action, extra = {}) => track('roadmap_board_step_action', { surface, action, ...extra });

  // Complete from the subtask offer comes back to the overview, where the status row says what happened and offers Undo.
  // Undo gives the step back the mark it had before, with no ceremony and no activity.
  const complete = (action) => {
    const before = { completed, completedAt };
    onComplete(id);
    setSection('overview');
    setOutcome({ kind: 'complete', line: completedOutcome({ unlocked: facts.opens.map(titleOf) }), undoable: true, before });
    act(action);
  };

  const reset = () => {
    const before = { completed, completedAt };
    onReset(id);
    setOutcome({ kind: 'reset', line: resetOutcome({ relocked: facts.relocks }), undoable: true, before });
    act('reset');
  };

  const undo = () => {
    try {
      onRestore(id, outcome.before);
      act('undo');
    } catch (error) {
      reportRoadmapFailure('roadmap-step-restore', error);
    }
    setOutcome(null);
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

  // The Tree section's control takes focus back once its picker, menu or sheet has gone: the + or the ⋯, whichever stands.
  const returnToTree = () => requestAnimationFrame(() => treeControl.current?.focus());
  const closePicker = () => {
    setTreePicker(false);
    returnToTree();
  };
  const setTree = (opens) => {
    const set = treeActs.set(id, opens);
    treeChanged.current = set.ok;
    return set;
  };
  const treeLink = editable && treeActs ? {
    control: treeControl,
    phone: surface === 'page',
    layer: layerRef,
    choose: () => {
      track('roadmap_tree_attach', { step: 'open', band: breakpoint, view: treeActs.view });
      setTreePicker(true);
    },
    detach: () => {
      setTree('');
      returnToTree();
    },
  } : null;
  closeTreePicker.current = treePicker && treeLink ? closePicker : null;
  const picker = treePicker && treeLink ? (
    <TreePicker
      step={titleOf(facts.step)}
      treeId={tree.treeId}
      standing={facts.opening?.treeId ?? ''}
      attachment={(complete) => treeAttachment(tree, { completed }, id, { complete })}
      trees={treeActs.trees}
      layout={surface === 'page' ? 'phone' : 'page'}
      headingId={pickerTitleId}
      band={breakpoint}
      view={treeActs.view}
      onAttach={(opens) => { if (setTree(opens).ok) closePicker(); }}
      onCancel={closePicker}
    />
  ) : null;

  const menuItems = [
    stepLink && { label: STEP_DETAIL.copyLink, icon: StepIcons.copyLink, run: copyLink },
    onOpenInGraph && { label: STEP_DETAIL.openInGraph, icon: StepIcons.graph, run: () => { act('openInGraph'); onOpenInGraph(id); } },
    onSelect && {
      label: STEP_DETAIL.select, icon: StepIcons.select,
      run: () => {
        selectingRef.current = true;
        act('select');
        onSelect(id);
      },
    },
    editable && deletable && {
      label: STEP_DETAIL.deleteStep, icon: StepIcons.trash, danger: true,
      run: () => {
        act('delete');
        setDeleting(true);
      },
    },
  ].filter(Boolean);

  const onKeyDown = (event) => wrapTab(event, layerRef.current);

  const offer = editable && section === 'workspace' && offersCompletion(workspace, facts)
    ? <SubtaskOffer onComplete={() => complete('completeFromSubtasks')} />
    : null;
  const shownSection = editable ? section : 'overview';
  const identity = <StepIdentity step={facts.step} titleId={titleId} compact={surface === 'page' && shownSection !== 'overview'} />;
  const cancelDelete = () => {
    setDeleting(false);
    onDeletePrompt?.('cancel');
  };
  const confirm = deleting ? {
    title: deleteConfirm({ step: titleOf(facts.step) }),
    cost: deleteCostLine(deletionCost(tree, [id])),
    cancel: cancelDelete,
    remove: () => {
      onDeletePrompt?.('confirm');
      deletedRef.current = id;
      setDeleting(false);
      onDelete(id);
    },
  } : null;
  const menu = noteEditing || menuItems.length === 0 ? null : <StepMenu items={menuItems} confirm={surface === 'modal' ? confirm : null} />;
  const sheet = surface === 'page' && confirm ? <DeleteConfirmation confirm={confirm} phone /> : null;
  const sections = editable && !noteEditing ? <StepSections idPrefix={sectionsId} section={section} onSection={(next) => {
    act('section', { section: next });
    setSection(next);
  }} /> : null;
  const edit = editable && onEdit ? () => {
    act('edit');
    onEdit(id);
  } : null;
  const noteAction = surface === 'page' && section === 'workspace';
  const noteLabel = workspace?.note ? STEP_DETAIL.editNote : WORKSPACE_EMPTY.addNote;
  const editLabel = noteAction ? noteLabel : STEP_DETAIL.editStep;
  const actions = editable && !noteEditing && (facts.column !== 'locked' || noteAction || edit || facts.opening)
    ? <StepActions facts={facts} phone={surface === 'page'} onComplete={() => complete('complete')} onReset={reset} onOpenTree={openTree}
        editLabel={editLabel} editRef={pinnedNoteRef} onEdit={noteAction ? () => workspaceRef.current?.openNote(pinnedNoteRef) : edit} />
    : null;
  const liveChecked = checked && surface === 'page' && workspace?.subtasks?.some((item) => item.id === checked.id && item.done);
  const checkedNotice = liveChecked && !noteEditing ? <div className="st-board-step-checked">
    <StepIcons.statusDone />
    <span aria-hidden="true">{checkedToast({ item: checked.label })}</span>
    <button type="button" onClick={() => {
      workspaceActions.onToggleSubtask(id, checked.id);
      setChecked(null);
      track('roadmap_board_workspace', { action: 'undo' });
    }}>{LABELS.undo}</button>
  </div> : null;
  const requestClose = () => {
    if (picker) {
      closePicker();
      return;
    }
    if (noteEditing) {
      workspaceRef.current?.close();
      return;
    }
    onClose();
  };
  const content = (
    <DetailFocusContext.Provider value={detailFocus}>
      <div id={`${sectionsId}-${shownSection}`} role={editable && !noteEditing ? 'tabpanel' : undefined} aria-labelledby={editable && !noteEditing ? `${sectionsId}-tab-${shownSection}` : undefined} className={`st-board-step-panel${noteEditing ? ' st-board-step-panel--editing' : ''}`}>
        {shownSection === 'overview' && (
          <Overview
            facts={facts}
            outcome={outcome}
            onUndo={undo}
            onOpenStep={onOpenStep}
            onOpenTree={openTree}
            treeLink={treeLink}
            onViewBranch={editable && facts.column !== 'locked' ? () => { act('viewBranch'); onViewBranch(id); } : null}
          />
        )}
        {shownSection === 'workspace' && (
          <StepWorkspace key={id} ref={workspaceRef} nodeId={id} title={titleOf(facts.step)} workspace={workspace}
            actions={workspaceActions} phone={surface === 'page'} onEditing={setNoteEditing}
            onEditNote={() => act('editNote')} onChecked={(item) => {
              if (surface !== 'page') return;
              setChecked(item.done ? null : { id: item.id, label: item.label });
            }} />
        )}
        {shownSection === 'history' && <StepHistory history={history} nodeId={id} phone={surface === 'page'} />}
      </div>
    </DetailFocusContext.Provider>
  );

  // Below 744px the step overlays the current view; from 744px it uses the 05.06 modal.
  if (surface === 'page') {
    const previous = trail.length > 1 ? tree.nodesById.get(trail[trail.length - 2]) : null;
    const backLabel = previous ? titleOf(previous) : roadmapTitle;
    return (
      <div ref={layerRef} className="st-board-step-layer" onKeyDown={onKeyDown}>
        <div className="st-board-step-page" role="dialog" aria-modal="true" aria-labelledby={noteEditing ? undefined : titleId} aria-label={noteEditing ? STEP_DETAIL.editNote : undefined} tabIndex={-1}>
          <div className="st-board-step-page-nav" inert={noteEditing ? '' : undefined}>
            <button type="button" className="st-board-step-page-back" aria-label={backTo({ screen: backLabel })} onClick={onBack}>
              <span className="st-board-step-page-back-glyph"><StepIcons.back /></span>
              <span className="st-board-step-page-back-label">{backLabel}</span>
            </button>
            {menu}
          </div>
          <div className="st-board-step-page-scroll" tabIndex={-1}>
            {!noteEditing && identity}
            {!noteEditing && offer}
            {content}
          </div>
          {sheet}
          {picker}
          <span className="st-board-step-checked-announcement" role="status" aria-live="polite" aria-atomic="true">
            {liveChecked && !noteEditing ? checkedToast({ item: checked.label }) : ''}
          </span>
          {checkedNotice}
          {(sections || actions) && (
            <div className="st-board-step-page-pinned">
              {sections}
              {actions}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div ref={layerRef} className="st-board-step-layer" onKeyDown={onKeyDown}>
      <div className="st-board-step-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
        <div className="st-board-step-modal" role="dialog" aria-modal="true" aria-labelledby={picker ? pickerTitleId : titleId} tabIndex={-1}>
          {picker ?? (
            <>
              <div className="st-board-step-modal-tools">
                {identity}
                {menu}
                <button type="button" className="st-board-step-icon-button" aria-label={STEP_DETAIL.close} onClick={requestClose}>
                  <StepIcons.close />
                </button>
              </div>
              {sections}
              <div className="st-board-step-modal-content" tabIndex={-1}>{content}</div>
              {!noteEditing && (offer || actions) && (
                <div className="st-board-step-modal-actions">
                  {offer}
                  {actions}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIdentity({ step, titleId, compact = false }) {
  const kind = hueOf(step.color);
  return (
    <div className={`st-board-step-identity${compact ? ' st-board-step-identity--compact' : ''}`} style={{ '--st-board-step-rail': kind.base }}>
      {!compact && <span className="st-board-step-identity-rail" aria-hidden />}
      <h2 id={titleId} className="st-board-step-identity-title">{titleOf(step)}</h2>
    </div>
  );
}

// A locked step marks each unmet need on a sunken row with its column, on the page and in the modal (01.07, 03.07).
// View branch closes the step and scopes the Board to it (11.01); the owner's up next and done steps offer it.
function Overview({ facts, outcome, onUndo, onOpenStep, onOpenTree, treeLink, onViewBranch }) {
  const description = facts.step.description?.trim() ?? '';
  const links = (facts.step.links ?? []).filter((link) => SAFE_URL.test(link.url));
  const needing = facts.column === 'locked';
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
      {(facts.opening?.read || treeLink) && <TreeSection facts={facts} onOpen={onOpenTree} link={treeLink} />}
      {onViewBranch && (
        <div className="st-board-step-explore">
          <button type="button" className="st-board-step-view-branch" onClick={onViewBranch}>{STEP_DETAIL.viewBranch}</button>
        </div>
      )}
    </>
  );
}

// The step's column with a leading glyph; after Complete or Reset, Undo for the hold window and a line naming what moved.
function StatusRow({ facts, outcome, onUndo }) {
  const Glyph = STATUS_GLYPHS[facts.column];
  const label = facts.column === 'locked' ? lockedStatus({ toGo: facts.toGo }) : COLUMN_TITLES[facts.column];
  return (
    <div className={`st-board-step-status st-board-step-status--${facts.column}`} tabIndex={-1}>
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
      aria-label={t('roadmap.step.relatedLabel', { step: titleOf(related.step), state: STATE_WORDS[related.column] })}
      onClick={() => onOpen(related.id)}
    >
      <span className={`st-board-step-row-glyph st-board-step-row-glyph--${related.column}`}><Glyph /></span>
      <span className="st-board-step-row-label">{titleOf(related.step)}</span>
      {need && <span className="st-board-step-row-state">{COLUMN_TITLES[related.column]}</span>}
      <span className="st-board-step-row-chevron"><StepIcons.chevron /></span>
    </button>
  );
}

// The tree a step opens, after what it needs and unlocks: the row goes into the tree, and one line says what completes
// the step. A tree nothing was read of shows no row, as every line of it would be a guess. `link` is the holder's way to
// attach, change and detach: with it the section stands on a step that opens no tree, as None and a +.
function TreeSection({ facts, onOpen, link }) {
  const { opening } = facts;
  const Row = onOpen ? 'button' : 'div';
  return (
    <section className="st-board-step-relations st-board-step-relations--tree">
      {link ? <TreeHeading facts={facts} link={link} /> : <h3 className="st-board-step-heading"><span>{TREE.heading}</span></h3>}
      {opening?.read && (
        <>
          <Row className={`st-board-step-tree st-board-step-tree--${opening.face}`} {...(onOpen ? { type: 'button', onClick: onOpen, 'aria-label': openTreeStated(opening, facts.roadmap) } : {})}>
            <span className="st-board-step-tree-glyph"><OpeningGlyph face={opening.face} size={16} check /></span>
            <span className="st-board-step-tree-facts">
              <span className="st-board-step-tree-title">{treeTitle(opening)}</span>
              <span className="st-board-step-tree-state">{treeState(opening, facts.roadmap)}</span>
              {opening.total > 0 && <OpeningBar opening={opening} />}
            </span>
            {onOpen && <span className="st-board-step-tree-chevron"><StepIcons.chevron /></span>}
          </Row>
          <p className="st-board-step-tree-rule">{treeRule(facts, Boolean(link))}</p>
        </>
      )}
    </section>
  );
}

// The Tree heading with the holder's control (28.54, 28.57): None and the + that attaches a tree, or the ⋯ over Change
// tree and Detach tree. The footnote's mark clause stands only where a mark was set aside.
function TreeHeading({ facts, link }) {
  const { opening, marked } = facts;
  if (!opening) {
    return (
      <div className="st-board-step-tree-heading">
        <h3 className="st-board-step-heading">
          <span>{TREE.heading}</span>
          <span className="st-board-step-heading-count">{t('roadmap.tree.none')}</span>
        </h3>
        <button ref={link.control} type="button" className="st-board-step-icon-button" aria-label={t('roadmap.treePicker.title')} onClick={link.choose}>
          <StepIcons.add />
        </button>
      </div>
    );
  }
  const named = marked ? t('roadmap.tree.menu.footnoteMark', { tree: opening.title }) : t('roadmap.tree.menu.footnote', { tree: opening.title });
  const unnamed = marked ? t('roadmap.tree.menu.footnoteUnnamedMark') : t('roadmap.tree.menu.footnoteUnnamed');
  return (
    <div className="st-board-step-tree-heading">
      <h3 className="st-board-step-heading"><span>{TREE.heading}</span></h3>
      <TreeMenu link={link} title={opening.title} footnote={opening.title ? named : unnamed} />
    </div>
  );
}

// The Tree heading's ⋯ (28.58, 28.65). From 744px a menu under the heading, standing in the step's layer so the
// scrolling step does not clip it, and gone once that scrolls; on phones a sheet over the whole screen with both rows
// in the reach band. Detaching destroys nothing, so no row is danger-toned and none asks.
function TreeMenu({ link, title, footnote }) {
  const [place, setPlace] = useState(null);
  const box = useRef(null);
  const noteId = useId();
  const open = place !== null;
  const rows = [
    { label: t('roadmap.tree.menu.change'), icon: StepIcons.graph, run: link.choose },
    { label: t('roadmap.tree.menu.detach'), icon: StepIcons.close, run: link.detach },
  ];
  const close = () => {
    setPlace(null);
    link.control.current?.focus();
  };

  useEffect(() => {
    if (!open || link.phone) return undefined;
    box.current.querySelector('[role="menuitem"]').focus();
    const away = (event) => {
      if (!box.current?.contains(event.target) && !link.control.current?.contains(event.target)) setPlace(null);
    };
    const moved = () => setPlace(null);
    window.addEventListener('pointerdown', away);
    window.addEventListener('resize', moved);
    window.addEventListener('scroll', moved, true);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', moved);
      window.removeEventListener('scroll', moved, true);
    };
  }, [open, link.phone]);

  const items = (className, role) => rows.map((row) => (
    <button key={row.label} type="button" role={role} className={className} onClick={() => {
      close();
      row.run();
    }}>
      <row.icon />
      {row.label}
    </button>
  ));

  return (
    <>
      <button
        ref={link.control}
        type="button"
        className="st-board-step-icon-button"
        aria-label={t('roadmap.tree.menu.actions')}
        aria-haspopup={link.phone ? 'dialog' : 'menu'}
        aria-expanded={open}
        onClick={() => {
          const under = link.control.current.getBoundingClientRect();
          const layer = link.layer.current.getBoundingClientRect();
          setPlace(open ? null : { top: under.bottom + 4 - layer.top, right: layer.right - under.right });
        }}
      >
        <StepIcons.more />
      </button>
      {open && !link.phone && createPortal(
        <div ref={box} className="st-board-step-tree-menu" style={place}
          onKeyDown={(event) => handleMenuKey(event, { root: box.current, onEscape: close, onTab: () => setPlace(null) })}>
          <div role="menu" aria-describedby={noteId}>{items('st-board-step-menu-item', 'menuitem')}</div>
          <p id={noteId} className="st-board-step-tree-footnote">{footnote}</p>
        </div>,
        link.layer.current,
      )}
      {open && link.phone && (
        <Sheet host={document.body} variant="tree" title={title || TREE.heading} onClose={close}
          headingStart={title ? <span className="st-board-tree-sheet-eyebrow">{TREE.heading}</span> : null}>
          {items('st-board-tree-sheet-row')}
          <p className="st-board-tree-sheet-footnote">{footnote}</p>
        </Sheet>
      )}
    </>
  );
}

// What completes a step that opens a tree: the one thing in the way first, then what it still needs, then its tree.
// Where the person can detach, a loop and a missing tree say the way out.
function treeRule({ opening, column, needs, roadmap }, detachable) {
  const tree = opening.title;
  if (opening.face === 'missing') return detachable ? t('roadmap.tree.rule.missingChoose') : t('roadmap.tree.rule.missing');
  if (opening.face === 'complete') return t('roadmap.tree.rule.complete', { tree });
  if (opening.face === 'loop') return detachable ? t('roadmap.tree.rule.loopDetach', { roadmap }) : t('roadmap.tree.rule.loop', { roadmap });
  if (opening.face === 'empty') return t('roadmap.tree.rule.empty');
  if (column !== 'locked') return t('roadmap.tree.rule.open', { tree });
  if (needs.length === 1) return t('roadmap.tree.rule.locked', { step: titleOf(needs[0]), tree });
  return t('roadmap.tree.rule.lockedMore', { step: titleOf(needs[0]), extra: formatCount(needs.length - 1), tree });
}

function StepSections({ idPrefix, section, onSection }) {
  const tabs = useRef({});
  const onKeyDown = (event) => {
    const index = STEP_SECTIONS.indexOf(section);
    const targets = {
      Home: STEP_SECTIONS[0],
      End: STEP_SECTIONS.at(-1),
      ArrowLeft: STEP_SECTIONS[(index - 1 + STEP_SECTIONS.length) % STEP_SECTIONS.length],
      ArrowRight: STEP_SECTIONS[(index + 1) % STEP_SECTIONS.length],
    };
    const next = targets[event.key];
    if (!next) return;
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

// Up next offers Complete; Done offers Reset, secondary, previewing what it returns to Locked. A step that opens a tree
// offers neither: where they sat it says what completes it, beside the way into the tree.
function StepActions({ facts, phone, onComplete, onReset, onOpenTree, editLabel, editRef, onEdit }) {
  const [previewing, setPreviewing] = useState(false);
  const preview = previewing && facts.takesMark && facts.column === 'done' ? resetPreview({ relocked: facts.relocks }) : null;
  const editOnly = facts.takesMark && facts.column === 'locked';
  const editClass = phone && !editOnly ? ' st-board-step-action--text' : '';
  if (!onEdit && editOnly) return null;
  return (
    <>
      {preview && <p className="st-board-step-preview">{preview}</p>}
      <div className="st-board-step-buttons">
        {onEdit && (
          <button
            ref={editRef}
            type="button"
            className={`st-board-step-action st-board-step-action--secondary${editClass}`}
            onClick={onEdit}
          >
            {editLabel}
          </button>
        )}
        {!facts.takesMark && <TreeBand facts={facts} onOpenTree={onOpenTree} />}
        {facts.takesMark && facts.column === 'upNext' && (
          <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={onComplete}>
            {STEP_DETAIL.complete}
          </button>
        )}
        {facts.takesMark && facts.column === 'done' && (
          <button
            type="button"
            className="st-board-step-action st-board-step-action--secondary"
            onClick={onReset}
            onPointerEnter={phone ? undefined : () => setPreviewing(true)}
            onPointerLeave={() => setPreviewing(false)}
            onFocus={() => setPreviewing(true)}
            onBlur={() => setPreviewing(false)}
          >
            {STEP_DETAIL.reset}
          </button>
        )}
      </div>
    </>
  );
}

// Going in is primary only while it is the way forward: the step up next, and nothing in its tree's way.
function TreeBand({ facts, onOpenTree }) {
  const { opening, column, toGo } = facts;
  const words = treeBand(opening, { column, toGo });
  const forward = opening.workable && column === 'upNext';
  const waiting = opening.workable && column === 'locked';
  return (
    <>
      {words && (
        <span className={`st-board-step-tree-band st-board-step-tree-band--${opening.face}`}>
          {waiting ? <StepIcons.statusLocked /> : <OpeningGlyph face={opening.face} size={14} />}
          {words}
        </span>
      )}
      {onOpenTree && (
        <button type="button" className={`st-board-step-action st-board-step-action--tree st-board-step-action--${forward ? 'primary' : 'secondary'}`} onClick={onOpenTree}>
          {TREE.open}
        </button>
      )}
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
function StepMenu({ items, confirm }) {
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

  const onKeyDown = (event) => handleMenuKey(event, {
    root: box.current,
    onEscape: () => {
      setOpen(false);
      opener.current.focus();
    },
    onTab: () => setOpen(false),
  });

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
      {confirm && <DeleteConfirmation confirm={confirm} />}
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

function DeleteConfirmation({ confirm, phone = false }) {
  const ref = useRef(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const opener = document.activeElement;
    ref.current.querySelector('button').focus();
    const hidden = [];
    let branch = ref.current;
    while (branch.parentElement && !branch.classList.contains('st-board-step-layer')) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling.inert) continue;
        sibling.inert = true;
        hidden.push(sibling);
      }
      branch = branch.parentElement;
    }
    const away = (event) => {
      if (ref.current.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      confirm.cancel();
    };
    document.addEventListener('pointerdown', away, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      for (const element of hidden) element.inert = false;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className={phone ? 'st-board-delete-overlay' : undefined}>
      <div ref={ref} className={`st-board-delete${phone ? ' st-board-delete--phone' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby={title} aria-describedby={description}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            confirm.cancel();
            return;
          }
          wrapTab(event, ref.current);
        }}>
        <h3 id={title}>{confirm.title}</h3>
        <p id={description}>{confirm.cost}</p>
        <div className="st-board-delete-buttons">
          <button type="button" onClick={confirm.cancel}>{DELETE_CONFIRM.cancel}</button>
          <button type="button" className="st-board-delete-danger" onClick={confirm.remove}>{DELETE_CONFIRM.delete}</button>
        </div>
      </div>
    </div>
  );
}
