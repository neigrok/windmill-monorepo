// The shared step document; nested editors and pickers own their own dialogs.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Crosshair, Lock, PanelRightClose, PanelRightOpen, Pencil, Undo2, Users } from 'lucide-react';
import './detail.css';
import { track } from '../../../telemetry/beacon.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { hueOf } from '../theme.js';
import { SAFE_URL } from '../graph/tree/NodeWorkspace.jsx';
import { StepWorkspace, StepHistory } from './StepWorkspace.jsx';
import { deletionCost } from '../board/acts.js';
import { StepFacts, offersCompletion, titleOf } from './StepFacts.js';
import { Sheet, handleMenuKey } from '../board/BoardControls.jsx';
import { treeAttachment } from '../model/UnlockRules.js';
import { StepIcons } from './StepIcons.jsx';
import { TreePicker } from './TreePicker.jsx';
import { OpeningBar, OpeningGlyph } from '../OpeningMarks.jsx';
import { useTreeDoor } from '../room/useTreeVisit.js';
import { DetailFocusContext } from './composerFocus.js';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { boardFocusTarget } from '../board/traversal.js';
import { RefusedSync } from '../sync/SyncNotices.jsx';
import './read.css';
import {
  COLUMN_TITLES, LABELS, deleteCostLine, LINK_COPIED, STATE_WORDS, STEP_DETAIL, TREE, checkedToast,
  DELETE_CONFIRM, deleteConfirm, backTo, completedOutcome, formatCount, lockedStatus, resetOutcome, resetPreview,
  openTreeLabel, openTreeStated, treeBand, treeState, treeTitle,
} from '../copy.js';
import { t } from '../i18n/index.js';

const UNDO_HOLD_MS = 6000;
// The second press of a double press on Attach comes within this; it lands where Attach was, on the step beneath.
const DOUBLE_PRESS_MS = 500;
const ROW_GLYPHS = { done: StepIcons.rowDone, upNext: StepIcons.rowUpNext, locked: StepIcons.rowLocked };
const STATUS_GLYPHS = { done: StepIcons.statusDone, upNext: StepIcons.statusUpNext, locked: StepIcons.statusLocked };

// Only the owner receives a workspace and write actions. Readers share the description, relationships and history.
export function StepDetail({
  tree,
  completed,
  completedAt,
  address,
  breakpoint,
  roadmapTitle,
  editable = false,
  refusal = null,
  progressBlocked = false,
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
  kindLabel = null,
  onAddStep,
  onConnect,
}) {
  const { id, trail, door } = address;
  const phone = breakpoint === 'phone';
  const surface = 'document';
  const facts = useMemo(() => new StepFacts(tree, { completed, completedAt }, id), [tree, completed, completedAt, id]);
  const openTree = useTreeDoor(facts.step, 'step');
  const layerRef = useRef(null);
  const refusalRef = useRef(null);
  const refusalFocus = useRef(null);
  const originRef = useRef(null);
  const directLink = useRef(door === 'link');
  const deletedRef = useRef(null);
  const selectingRef = useRef(false);
  const leaveRef = useRef(null);
  const workspaceRef = useRef(null);
  const scrollRef = useRef(null);
  const sectionScroll = useRef(null);
  // Returning to the same address starts a new lifetime; an old clipboard request cannot re-enter it.
  const copyScope = useMemo(() => ({ id, link: stepLink }), [id, stepLink]);
  const currentCopyScope = useRef(copyScope);
  const copyAttempt = useRef(null);
  const copyOrigin = useRef(null);
  const copyCard = useRef(null);
  const copyRetry = useRef(null);
  const copyField = useRef(null);
  const currentStep = useRef(id);
  currentStep.current = id;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const editingRef = useRef(false);
  const treeControl = useRef(null);
  const closeTreePicker = useRef(null);
  const treeChanged = useRef(false);
  const attachedAt = useRef(-Infinity);
  const titleId = useId();
  const pickerTitleId = useId();
  const sectionsId = useId();
  const copyTitleId = useId();
  const copyFieldId = useId();
  const [stepShown, setStepShown] = useState(id);
  const [coachOpen, setCoachOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1440);
  const [compactNotice, setCompactNotice] = useState(phone);
  const [discardNotice, setDiscardNotice] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [noteEditing, setNoteEditing] = useState(false);
  const [checked, setChecked] = useState(null);
  const [treePicker, setTreePicker] = useState(false);
  const [copyRecovery, setCopyRecovery] = useState(null);
  const [copyBusy, setCopyBusy] = useState(false);
  originRef.current = trail[0];
  leaveRef.current = onClose;
  editingRef.current = editable && noteEditing;

  if (copyRecovery && copyRecovery.scope !== copyScope) setCopyRecovery(null);

  if (stepShown !== id) {
    setStepShown(id);
    setOutcome(null);
    setDeleting(false);
    setNoteEditing(false);
    setChecked(null);
    setTreePicker(false);
    treeChanged.current = false;
    attachedAt.current = -Infinity;
  }

  if (!editable) {
    if (outcome) setOutcome(null);
    if (deleting) setDeleting(false);
    if (noteEditing) setNoteEditing(false);
    if (checked) setChecked(null);
    if (treePicker) setTreePicker(false);
  }

  if (outcome && facts.marked !== (outcome.kind === 'complete')) setOutcome(null);

  if (checked && !workspace?.subtasks?.some((item) => item.id === checked.id && item.done)) {
    setChecked(null);
  }

  const restoreDetailFocus = useCallback((openerRef) => {
    const stepId = currentStep.current;
    const restore = () => {
      if (currentStep.current !== stepId) return;
      const layer = layerRef.current;
      if (!layer || layer.closest('[inert]')) return;
      const active = document.activeElement;
      if (active !== document.body && active?.isConnected && !layer.querySelector('article')?.contains(active) && !active.closest('[inert]')) return;
      const opener = openerRef?.current;
      if (opener?.isConnected && !opener.closest('[inert]') && opener.getClientRects().length > 0) {
        opener.focus({ preventScroll: true });
        return;
      }
      if (editingRef.current) return;
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      const target = layer.querySelector('.st-board-step-status') ?? layer.querySelector('article');
      target?.focus({ preventScroll: true });
    };
    if (openerRef) requestAnimationFrame(restore);
    else restore();
  }, []);
  const detailFocus = useMemo(() => ({ restore: restoreDetailFocus }), [restoreDetailFocus]);

  useLayoutEffect(() => {
    currentCopyScope.current = copyScope;
    return () => { currentCopyScope.current = null; };
  }, [copyScope]);

  useLayoutEffect(() => {
    const article = layerRef.current.querySelector('article');
    const measure = () => setCompactNotice(article.clientWidth < 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(article);
    return () => observer.disconnect();
  }, []);

  const notice = editable ? discardNotice ?? refusal : null;
  const refusalShown = Boolean(notice);
  useEffect(() => {
    refusalFocus.current = null;
    if (!refusalShown) return undefined;
    const followFocus = (event) => { refusalFocus.current = refusalRef.current?.contains(event.target) ? document.activeElement : null; };
    document.addEventListener('focusin', followFocus);
    document.addEventListener('pointerdown', followFocus, true);
    return () => {
      document.removeEventListener('focusin', followFocus);
      document.removeEventListener('pointerdown', followFocus, true);
    };
  }, [refusalShown, id]);

  useLayoutEffect(() => {
    if (refusalShown || !refusalFocus.current) return;
    const previousFocus = refusalFocus.current;
    refusalFocus.current = null;
    const layer = layerRef.current;
    if (!editable || layer.closest('[inert]')) return;
    const active = document.activeElement;
    if (active !== document.body && active?.isConnected && active !== previousFocus) return;
    const target = layer.querySelector('.st-board-step-undo:not(:disabled)') ?? layer.querySelector('.st-board-step-identity-title');
    target?.focus();
  }, [refusalShown, editable]);

  useEffect(() => {
    const root = layerRef.current?.closest('.st-root');
    return () => {
      currentStep.current = null;
      cancelAnimationFrame(sectionScroll.current);
      const returnTo = originRef.current;
      requestAnimationFrame(() => {
        if (selectingRef.current || (root && !root.isConnected)) return;
        const active = document.activeElement;
        if (active !== document.body && active?.isConnected && !active.closest('[inert]')) return;
        if (directLink.current && root?.isConnected) {
          root.querySelector('.st-roadmap-identity')?.focus({ preventScroll: true });
          return;
        }
        const board = document.querySelector('.st-view-layer--board.is-active');
        if (!board || board.closest('[inert]')) return;
        const target = boardFocusTarget(board, {
          preferredId: deletedRef.current === null ? returnTo : null,
          excludeId: deletedRef.current,
        });
        const column = [...board.querySelectorAll('[data-column]')].find((element) => element.getClientRects().length > 0);
        (target === board ? column ?? target : target)?.focus({ preventScroll: true });
      });
    };
  }, []);

  useLayoutEffect(() => {
    if (!copyRecovery || currentCopyScope.current !== copyRecovery.scope || copyCard.current?.closest('[inert]')) return;
    (copyRecovery.revealed ? copyField : copyRetry).current?.focus({ preventScroll: true });
  }, [copyRecovery]);

  useEffect(() => {
    cancelAnimationFrame(sectionScroll.current);
    const layer = layerRef.current;
    if (layer.closest('[inert]') || editingRef.current) return;
    layer.querySelector('article').focus({ preventScroll: true });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [id]);

  useEffect(() => {
    if (door !== 'back') track('roadmap_board_step_open', { surface, column: facts.column, door });
  }, [id, door]);

  useEffect(() => { restoreDetailFocus(null); }, [facts.column, outcome?.undoable, restoreDetailFocus]);

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

  // Completion and Undo retain this document and report their outcome beside its pinned actions.
  const complete = (action) => {
    if (!editableRef.current || progressBlocked || currentStep.current !== id) return;
    const before = { completed, completedAt };
    if (onComplete(id) === false) return;
    setOutcome({ kind: 'complete', line: completedOutcome({ unlocked: facts.opens.map(titleOf) }), undoable: true, before });
    act(action);
  };

  const reset = () => {
    if (!editableRef.current || progressBlocked || currentStep.current !== id) return;
    const before = { completed, completedAt };
    if (onReset(id) === false) return;
    setOutcome({ kind: 'reset', line: resetOutcome({ relocked: facts.relocks }), undoable: true, before });
    act('reset');
  };

  const undo = () => {
    if (!editableRef.current || progressBlocked || currentStep.current !== id || !outcome?.undoable) return;
    try {
      if (onRestore(id, outcome.before) === false) return;
      act('undo');
    } catch (error) {
      reportRoadmapFailure('roadmap-step-restore', error);
    }
    setOutcome(null);
  };

  const restoreCopyFocus = () => {
    for (const control of [copyOrigin.current?.control, copyOrigin.current?.menu]) {
      if (!control?.isConnected || control.closest('[inert]') || !control.getClientRects().length) continue;
      control.focus({ preventScroll: true });
      return;
    }
  };
  const dismissCopyRecovery = () => {
    if (copyAttempt.current) copyAttempt.current.dismissed = true;
    setCopyRecovery(null);
    act('copyLinkRecovery', { step: 'dismiss' });
    restoreCopyFocus();
  };
  const copyLink = async (control, menu) => {
    if (!stepLink || currentCopyScope.current !== copyScope || copyAttempt.current) return;
    const attempt = { scope: copyScope, dismissed: false };
    copyAttempt.current = attempt;
    setCopyBusy(true);
    if (control) copyOrigin.current = { control, menu };
    if (copyRecovery) act('copyLinkRecovery', { step: 'retry' });
    let copied = false;
    try {
      await navigator.clipboard.writeText(copyScope.link);
      copied = true;
    } catch (error) {
      if (error?.name !== 'NotAllowedError' && error?.name !== 'SecurityError') reportRoadmapFailure('roadmap-step-copy', error);
    }
    copyAttempt.current = null;
    act('copyLink', { outcome: copied ? 'ok' : 'failed' });
    if (!currentCopyScope.current) return;
    setCopyBusy(false);
    if (currentCopyScope.current !== attempt.scope || attempt.dismissed) return;
    if (copied) {
      if (copyCard.current?.contains(document.activeElement)) restoreCopyFocus();
      setCopyRecovery(null);
      onNotify(LINK_COPIED);
      return;
    }
    if (copyRecovery) return;
    setCopyRecovery({ scope: copyScope, revealed: false });
    act('copyLinkRecovery', { step: 'shown' });
  };

  // The Tree section's control takes focus back once its picker, menu or sheet has gone: the + or the ⋯, whichever stands.
  const returnToTree = () => requestAnimationFrame(() => {
    if (currentStep.current !== id) return;
    const active = document.activeElement;
    if (active !== document.body && active?.isConnected && !layerRef.current?.querySelector('article')?.contains(active)) return;
    treeControl.current?.focus({ preventScroll: true });
  });
  const closePicker = () => {
    setTreePicker(false);
    returnToTree();
  };
  // `chosen` is the picker's row of the tree to open, or null to open none.
  const setTree = (chosen) => {
    const set = treeActs.set(id, chosen);
    treeChanged.current = set.ok;
    return set;
  };
  const swallowSecondPress = (event) => {
    if (event.detail < 2 || performance.now() - attachedAt.current > DOUBLE_PRESS_MS) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // A step that owns a subtree opens it for good: no pointer is attached to it, changed or detached.
  const treeLink = editable && treeActs && !facts.opening?.owned ? {
    control: treeControl,
    phone,
    layer: layerRef,
    choose: () => {
      track('roadmap_tree_attach', { step: 'open', band: breakpoint, view: treeActs.view, place: treeActs.trees.place });
      setTreePicker(true);
    },
    detach: () => {
      setTree(null);
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
      layout={phone ? 'phone' : 'page'}
      headingId={pickerTitleId}
      band={breakpoint}
      view={treeActs.view}
      onAttach={(chosen) => {
        if (!setTree(chosen).ok) return false;
        attachedAt.current = performance.now();
        closePicker();
        return true;
      }}
      onLapse={treeActs.lapsed}
      onCancel={closePicker}
    />
  ) : null;

  const openInGraph = () => {
    selectingRef.current = true;
    act('openInGraph');
    onOpenInGraph(id);
  };

  const menuItems = [
    editable && onAddStep && { label: t('roadmap.tablet.addStep'), icon: StepIcons.add, run: () => { act('addStep'); onAddStep(id); } },
    editable && onConnect && { label: t('roadmap.tablet.connect'), icon: StepIcons.graph, run: () => { act('connect'); onConnect(id); } },
    stepLink && { label: STEP_DETAIL.copyLink, icon: StepIcons.copyLink, run: copyLink },
    onOpenInGraph && { label: STEP_DETAIL.openInGraph, icon: StepIcons.graph, run: openInGraph },
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

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.currentTarget.closest('[inert]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (closeTreePicker.current) { closeTreePicker.current(); return; }
    if (editingRef.current) { workspaceRef.current?.close(); return; }
    if (copyRecovery) { dismissCopyRecovery(); return; }
    leaveRef.current();
  };
  const jumpTo = (section) => {
    const scroll = scrollRef.current;
    const target = layerRef.current.querySelector(`#${CSS.escape(sectionsId + '-' + section)}`);
    if (!scroll || !target) return;
    act('section', { section });
    cancelAnimationFrame(sectionScroll.current);
    const start = scroll.scrollTop;
    const end = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight,
      target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + start));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { scroll.scrollTop = end; return; }
    const began = performance.now();
    const advance = (now) => {
      const portion = Math.min(1, (now - began) / 180);
      scroll.scrollTop = start + (end - start) * (1 - Math.pow(1 - portion, 3));
      if (portion < 1) sectionScroll.current = requestAnimationFrame(advance);
    };
    sectionScroll.current = requestAnimationFrame(advance);
  };
  const cancelDelete = () => { setDeleting(false); onDeletePrompt?.('cancel'); };
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
  const edit = editable && onEdit ? () => { act('edit'); onEdit(id); } : null;
  const previous = trail.length > 1 ? tree.nodesById.get(trail[trail.length - 2]) : null;
  const backLabel = previous ? titleOf(previous) : roadmapTitle;
  const liveChecked = checked && phone && workspace?.subtasks?.some((item) => item.id === checked.id && item.done);
  const description = facts.step.description?.trim() ?? '';
  const links = (facts.step.links ?? []).filter((link) => SAFE_URL.test(link.url));
  const kind = hueOf(facts.step.color);
  const discard = async () => {
    if (discardNotice) return;
    setDiscardNotice(notice);
    try { await notice.onDiscard(); }
    finally { setDiscardNotice(null); }
  };
  return (
    <DetailFocusContext.Provider value={detailFocus}>
      <div ref={layerRef} className={`st-board-step-layer st-step-read-shell${phone ? ' is-phone' : ''}`} onClickCapture={swallowSecondPress} onKeyDown={copyRecovery ? onKeyDown : undefined}>
        <article className="st-step-document" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
          <header className="st-step-toolbar">
            <button type="button" className="st-step-breadcrumb" aria-label={backTo({ screen: backLabel })} onClick={onBack}>
              {phone || previous ? <StepIcons.back /> : <StepIcons.graph />}
              <span>{backLabel}</span>
              {!phone && !previous && <><StepIcons.chevron /><span>{t('roadmap.step.readStep')}</span></>}
            </button>
            {onOpenInGraph && <button type="button" className="st-step-graph-link" aria-label={STEP_DETAIL.openInGraph} onClick={openInGraph}>
              <Crosshair size={16} aria-hidden /><span>{STEP_DETAIL.openInGraph}</span>
            </button>}
            {menuItems.length > 0 && <StepMenu items={menuItems} confirm={!phone ? confirm : null} />}
            <button type="button" className="st-board-step-icon-button" aria-label={STEP_DETAIL.close} onClick={onClose}><StepIcons.close /></button>
          </header>
          {refusalShown && <div ref={refusalRef} className="st-step-refusal" onClickCapture={() => { refusalFocus.current = document.activeElement; }}>
            <RefusedSync band={compactNotice ? 'phone' : breakpoint} {...notice} onDiscard={discard} disabled={Boolean(discardNotice)} />
          </div>}
          <div ref={scrollRef} className="st-step-document-scroll" onWheel={() => cancelAnimationFrame(sectionScroll.current)} onTouchStart={() => cancelAnimationFrame(sectionScroll.current)}>
            <div className="st-step-read-heading">
              <div className="st-step-read-tags">
                <span className="st-step-kind-label"><i style={{ background: kind.base }} />{kindLabel || facts.step.color}</span>
                <StatusRow facts={facts} />
              </div>
              <div className="st-step-read-title">
                <h2 id={titleId} className="st-board-step-identity-title" tabIndex={-1}>{titleOf(facts.step)}</h2>
                {edit && <button type="button" className="st-board-step-icon-button" aria-label={STEP_DETAIL.editStep} onClick={edit}><Pencil size={16} aria-hidden /></button>}
              </div>
            </div>
            <div className="st-step-document-grid">
              <section className="st-step-description-section">
                <h3 className="st-step-section-title">{t('roadmap.step.description')}</h3>
                {description && <p className="st-board-step-description">{description}</p>}
                {links.length > 0 && <div className="st-board-step-links">{links.map((link, index) => (
                  <a key={`${index}-${link.url}`} className="st-board-step-link" href={link.url} target="_blank" rel="noopener noreferrer">
                    <StepIcons.copyLink /><span className="st-board-step-link-label">{link.label || link.url}</span><StepIcons.external />
                  </a>
                ))}</div>}
              </section>
              <aside className="st-step-relationships">
                <Relationships facts={facts} onOpenStep={onOpenStep} onOpenTree={openTree} treeLink={treeLink}
                  onViewBranch={editable && facts.column !== 'locked' ? () => { act('viewBranch'); onViewBranch(id); } : null} />
                <nav className="st-step-section-links" aria-label={t('roadmap.step.sectionsLabel')}>
                  {editable && <button type="button" onClick={() => jumpTo('workspace')}><Lock size={16} aria-hidden /><strong>{t('roadmap.step.myWorkspace')}</strong><span>{t('roadmap.step.private')}</span><StepIcons.chevron /></button>}
                  <button type="button" onClick={() => jumpTo('history')}><Clock size={16} aria-hidden /><strong>{STEP_DETAIL.sections.history}</strong><StepIcons.chevron /></button>
                </nav>
              </aside>
              {editable && <section id={`${sectionsId}-workspace`} className="st-step-workspace-section">
                <h3 className="st-step-section-title"><Lock size={16} aria-hidden />{t('roadmap.step.myWorkspace')}<span>{t('roadmap.step.onlyYou')}</span></h3>
                <StepWorkspace key={id} ref={workspaceRef} nodeId={id} title={titleOf(facts.step)} workspace={workspace}
                  actions={workspaceActions} phone={phone} onEditing={setNoteEditing} onEditNote={() => act('editNote')}
                  onChecked={(item) => { if (phone) setChecked(item.done ? null : { id: item.id, label: item.label }); }} />
                {offersCompletion(workspace, facts) && <SubtaskOffer disabled={progressBlocked} onComplete={() => complete('completeFromSubtasks')} />}
              </section>}
              <section id={`${sectionsId}-history`} className="st-step-history-section">
                <h3 className="st-step-section-title"><Clock size={16} aria-hidden />{STEP_DETAIL.sections.history}</h3>
                <StepHistory history={history} nodeId={id} />
              </section>
            </div>
          </div>
          <span className="st-board-step-checked-announcement" role="status" aria-live="polite" aria-atomic="true">{liveChecked && !noteEditing ? checkedToast({ item: checked.label }) : ''}</span>
          {liveChecked && !noteEditing && <div className="st-board-step-checked"><StepIcons.statusDone /><span>{checkedToast({ item: checked.label })}</span>
            <button type="button" onClick={() => { workspaceActions.onToggleSubtask(id, checked.id); setChecked(null); track('roadmap_board_workspace', { action: 'undo' }); }}>{LABELS.undo}</button>
          </div>}
          <span className="st-board-step-checked-announcement" role="status" aria-live="polite" aria-atomic="true">{copyRecovery ? t('roadmap.step.copyFailed') : ''}</span>
          {copyRecovery && <div className="st-step-copy-anchor">
            <section ref={copyCard} className="st-step-copy-recovery" aria-labelledby={copyTitleId}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                dismissCopyRecovery();
              }}>
              <header>
                <h3 id={copyTitleId}>{t('roadmap.step.copyFailed')}</h3>
                <button type="button" className="st-board-step-icon-button" aria-label={t('roadmap.common.close')} onClick={dismissCopyRecovery}><StepIcons.close /></button>
              </header>
              <p>{copyRecovery.revealed ? t('roadmap.step.copyManually') : t('roadmap.step.copyRecovery')}</p>
              {copyRecovery.revealed && <>
                <label htmlFor={copyFieldId}>{t('roadmap.step.currentLink')}</label>
                <input ref={copyField} id={copyFieldId} type="text" readOnly value={copyScope.link} spellCheck={false} />
              </>}
              <div className="st-step-copy-actions">
                <button ref={copyRetry} type="button" className="st-board-step-action st-board-step-action--secondary" aria-disabled={copyBusy} onClick={() => copyLink()}>{t('roadmap.common.tryAgain')}</button>
                <button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={() => {
                  if (copyRecovery.revealed) {
                    copyField.current.focus();
                    copyField.current.select();
                    act('copyLinkRecovery', { step: 'select' });
                    return;
                  }
                  setCopyRecovery({ ...copyRecovery, revealed: true });
                  act('copyLinkRecovery', { step: 'reveal' });
                }}>{copyRecovery.revealed ? t('roadmap.step.selectLink') : t('roadmap.step.showLink')}</button>
              </div>
            </section>
          </div>}
          <footer className="st-step-pinned-actions">
            {!(phone && outcome) && <span className="st-step-shared-label"><Users size={14} aria-hidden />{t('roadmap.step.sharedStep')}</span>}
            <p className="st-board-step-outcome" role="status">{outcome?.line ?? ''}</p>
            {editable && outcome?.undoable && <button type="button" className="st-board-step-undo st-board-step-action st-board-step-action--secondary" disabled={progressBlocked} onClick={undo}><Undo2 size={18} aria-hidden />{LABELS.undo}</button>}
            {editable && !noteEditing && <StepActions facts={facts} phone={phone} progressBlocked={progressBlocked} onComplete={() => complete('complete')} onReset={reset} onOpenTree={openTree} />}
            {!editable && facts.opening?.owned && openTree && <div className="st-board-step-buttons"><TreeBand facts={facts} onOpenTree={openTree} /></div>}
          </footer>
          {phone && <div className="st-step-phone-coach" aria-hidden />}
          {phone && confirm && <DeleteConfirmation confirm={confirm} phone />}
          {picker && <div className="st-step-picker-host" onPointerDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); closePicker(); } }}>{picker}</div>}
        </article>
        {!phone && <aside className={`st-step-coach${coachOpen ? ' is-expanded' : ''}`} aria-label={t('roadmap.step.coach')}>
          <header>
            {coachOpen && <h2>{t('roadmap.step.coach')}</h2>}
            <button type="button" aria-label={coachOpen ? t('roadmap.step.collapseCoach') : t('roadmap.step.expandCoach')} aria-expanded={coachOpen}
              onClick={() => { act(coachOpen ? 'collapseCoach' : 'expandCoach'); setCoachOpen(!coachOpen); }}>
              {coachOpen ? <PanelRightClose size={20} aria-hidden /> : <><PanelRightOpen size={20} aria-hidden /><span>{t('roadmap.step.coach')}</span></>}
            </button>
          </header>
        </aside>}
      </div>
    </DetailFocusContext.Provider>
  );
}

function Relationships({ facts, onOpenStep, onOpenTree, treeLink, onViewBranch }) {
  const needing = facts.column === 'locked';
  return (
    <>
      {facts.prerequisites.length > 0 && (
        <section className="st-board-step-relations">
          <h3 className="st-board-step-heading">
            <span>{t('roadmap.step.requires')}</span>
            <span className="st-board-step-heading-count">{t('roadmap.step.requiresDone', { done: formatCount(facts.prerequisitesDone), total: formatCount(facts.prerequisites.length) })}</span>
          </h3>
          {facts.prerequisites.map((related) => (
            <RelationRow key={related.id} related={related} need={needing && related.column !== 'done'} onOpen={onOpenStep} />
          ))}
        </section>
      )}
      {facts.unlocks.length > 0 && (
        <section className="st-board-step-relations">
          <h3 className="st-board-step-heading">
            <span>{t('roadmap.step.opens')}</span>
            <span className="st-board-step-heading-count">{t('roadmap.step.opensCount', { count: facts.unlocks.length })}</span>
          </h3>
          {facts.unlocks.map((related) => <RelationRow key={related.id} related={related} onOpen={onOpenStep} />)}
        </section>
      )}
      {!facts.opening?.owned && (facts.opening?.read || treeLink) && <TreeSection facts={facts} onOpen={onOpenTree} link={treeLink} />}
      {onViewBranch && (
        <div className="st-board-step-explore">
          <button type="button" className="st-board-step-view-branch" onClick={onViewBranch}>{STEP_DETAIL.viewBranch}</button>
        </div>
      )}
    </>
  );
}

// The step's derived column with its leading glyph.
function StatusRow({ facts }) {
  const Glyph = STATUS_GLYPHS[facts.column];
  const label = facts.column === 'locked' ? lockedStatus({ toGo: facts.toGo }) : COLUMN_TITLES[facts.column];
  return (
    <div className={`st-board-step-status st-board-step-status--${facts.column}`} tabIndex={-1}>
      <div className="st-board-step-status-row">
        <span className="st-board-step-status-glyph"><Glyph /></span>
        <span className="st-board-step-status-label">{label}</span>
      </div>
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
      <span className="st-board-step-row-state">{COLUMN_TITLES[related.column]}</span>
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

// Up next offers Complete; Done offers Reset, secondary, previewing what it returns to Locked. A step that opens a tree
// offers neither: where they sat it says what completes it, beside the way into the tree.
function StepActions({ facts, phone, progressBlocked, onComplete, onReset, onOpenTree }) {
  const [previewing, setPreviewing] = useState(false);
  const preview = previewing && facts.takesMark && facts.column === 'done' ? resetPreview({ relocked: facts.relocks }) : null;
  if (facts.takesMark && facts.column === 'locked') return null;
  return (
    <>
      {preview && <p className="st-board-step-preview">{preview}</p>}
      <div className="st-board-step-buttons">
        {!facts.takesMark && <TreeBand facts={facts} onOpenTree={onOpenTree} />}
        {facts.takesMark && facts.column === 'upNext' && (
          <button type="button" className="st-board-step-action st-board-step-action--primary" disabled={progressBlocked} onClick={onComplete}>
            {STEP_DETAIL.complete}
          </button>
        )}
        {facts.takesMark && facts.column === 'done' && (
          <button
            type="button"
            className="st-board-step-action st-board-step-action--secondary"
            disabled={progressBlocked}
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
  const words = opening.owned ? treeState(opening, facts.roadmap) : treeBand(opening, { column, toGo });
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
          {openTreeLabel(opening)}
        </button>
      )}
    </>
  );
}

function SubtaskOffer({ onComplete, disabled }) {
  return (
    <div className="st-board-step-offer">
      <span className="st-board-step-offer-glyph"><StepIcons.offer /></span>
      <span className="st-board-step-offer-body">{STEP_DETAIL.subtaskOffer.body}</span>
      <button type="button" className="st-board-step-offer-action" disabled={disabled} onClick={onComplete}>{STEP_DETAIL.subtaskOffer.action}</button>
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
              onClick={(event) => {
                setOpen(false);
                opener.current.focus();
                item.run(event.currentTarget, opener.current);
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
