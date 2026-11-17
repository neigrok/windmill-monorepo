import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../design-system';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { registerNavigationGuard, requestNavigation, readNavigation } from '../../../shell/navigation.js';
import { useAppearance } from '../../../shell/useAppearance.js';
import { track } from '../../../telemetry/beacon.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { t } from '../i18n/index.js';
import { InlineStepDraft, fieldValue } from './InlineStepDraft.js';
import { stepDraftSession } from './StepDraftSession.js';
import { coverBeneath, useComposerViewport } from './composerFocus.js';
import './inline-edit.css';

const DraftContext = createContext(null);

export function fieldLabel(field) {
  return { label: t('roadmap.inline.name'), description: t('roadmap.inline.description'), color: t('roadmap.inline.kind'), prerequisites: t('roadmap.inline.prerequisites') }[field];
}

export function StepDraftProvider({ dataScope, store: suppliedStore, children }) {
  const { resolved: theme } = useAppearance();
  const [store] = useState(() => suppliedStore ?? stepDraftSession(document));
  store.bindScope(dataScope);
  const scope = useSyncExternalStore(dataScope.subscribe, dataScope.getSnapshot, dataScope.getSnapshot);
  const slot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [recovery, setRecovery] = useState(null);
  const [decision, setDecision] = useState(null);
  const [copyState, setCopyState] = useState(null);
  const [returnState, setReturnState] = useState(null);
  const pending = useRef(null);
  const room = useRef(null);
  const input = useRef(null);
  const launcher = useRef(null);
  const invoker = useRef(null);
  const viewButton = useRef(null);
  const focusState = useRef(null);
  const returnTimer = useRef(null);
  const copyAttempt = useRef(0);
  const current = () => store.getSnapshot();
  const event = (step, field = current()?.draft.field) => {
    if (!field) return;
    track('roadmap_step_edit', { step, field });
  };
  const recoverEvent = (step) => track('roadmap_step_draft', { step });
  const focusRoute = () => {
    const heading = document.querySelector('main h1, main h2, [role="main"] h1, .wm-page-content h1, .wm-page-content h2, main');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  };
  const restoreField = () => {
    const saved = focusState.current;
    const target = saved?.element?.isConnected ? saved.element : input.current;
    if (!target?.isConnected || target.closest('[inert]')) return;
    target.focus({ preventScroll: true });
    if (saved?.element === target && saved.start != null) target.setSelectionRange?.(saved.start, saved.end, saved.direction);
  };
  const captureField = () => {
    const element = input.current;
    focusState.current = element ? { element, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection } : null;
  };
  const restoreLauncher = (held) => {
    if (!held) return;
    const target = launcher.current;
    requestAnimationFrame(() => {
      if (current() || dataScope.getSnapshot().epoch !== held.epoch) return;
      const route = readNavigation();
      if (route.pathname !== held.route.pathname || route.search !== held.route.search || route.hash !== held.route.hash) return;
      const control = target?.isConnected ? target : document.querySelector(`[data-step-document-id="${CSS.escape(held.draft.stepId)}"] [data-step-field="${held.draft.field}"]`);
      if (control && !control.closest('[inert]')) control.focus({ preventScroll: true });
    });
  };
  const finishEditor = (token) => {
    const held = current();
    if (store.clear(token)) restoreLauncher(held);
  };
  const openRecovery = (element = document.activeElement) => {
    const held = current();
    if (!held || held.mode !== 'retained') return;
    invoker.current = element;
    copyAttempt.current += 1;
    setRecovery(held.token);
    setCopyState(null);
    recoverEvent('view');
  };
  const closeRecovery = () => {
    const held = current();
    setRecovery(null);
    recoverEvent('close');
    requestAnimationFrame(() => {
      if (!held || current()?.token !== held.token) return;
      const target = invoker.current?.isConnected ? invoker.current : viewButton.current?.querySelector('button');
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
      else focusRoute();
    });
  };
  const keep = () => {
    const held = pending.current;
    pending.current = null;
    setDecision(null);
    held?.cancel?.();
    if (held?.mode === 'retained') recoverEvent('keep');
    else event('keep');
    requestAnimationFrame(() => { if (current()?.token === held?.slotToken) restoreField(); });
  };
  const discard = () => {
    const held = pending.current;
    if (!held) return;
    pending.current = null;
    setDecision(null);
    const valid = store.clear(held.slotToken);
    if (!valid) { held.cancel?.(); return; }
    setRecovery(null);
    if (held.mode === 'retained') recoverEvent('discard');
    else event('discard', held.field);
    held.proceed?.();
    if (!held.proceed) requestAnimationFrame(focusRoute);
  };
  const askDiscard = (event) => {
    const held = current();
    if (!held || pending.current) return;
    focusState.current = { element: event.currentTarget };
    pending.current = { slotToken: held.token, mode: 'retained' };
    setDecision(pending.current);
    recoverEvent('discard_prompt');
  };

  useLayoutEffect(() => registerNavigationGuard({
    blocked: (context) => {
      const held = current();
      return held?.mode === 'active' || (held?.mode === 'retained' && context.kind === 'sign-out');
    },
    onBlocked: ({ token, context, proceed, cancel }) => {
      const held = current();
      if (!held) { proceed(); return; }
      if (held.mode === 'active' && !held.draft.dirty) { store.clear(held.token); proceed(); return; }
      captureField();
      if (held.mode === 'retained') focusState.current = { element: document.activeElement };
      const next = { token, slotToken: held.token, field: held.draft.field, mode: held.mode, context, proceed, cancel };
      pending.current = next;
      setDecision(next);
      if (held.mode === 'retained') recoverEvent('signout_prompt');
      else event('guard', held.draft.field);
    },
    onUnrestorableNavigation: () => {
      pending.current = null;
      setDecision(null);
      const held = current();
      if (held?.mode !== 'active') return;
      if (!held.draft.dirty) { store.clear(held.token); return; }
      store.retain(held.token);
      recoverEvent('retained');
    },
  }), [store]);

  useEffect(() => {
    if (scope.phase === 'ready' && slot) return;
    pending.current?.cancel?.();
    pending.current = null;
    setDecision(null);
    setRecovery(null);
    setCopyState(null);
    setReturnState(null);
    copyAttempt.current += 1;
    clearTimeout(returnTimer.current);
    input.current = null;
    focusState.current = null;
  }, [scope, slot]);
  useEffect(() => {
    const leave = (event) => {
      const held = current();
      if (!held || (!held.draft.dirty && held.mode !== 'retained')) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('beforeunload', leave); clearTimeout(returnTimer.current); };
  }, [store]);

  const copy = async () => {
    const held = current();
    if (!held || held.token !== slot?.token) return;
    const attempt = ++copyAttempt.current;
    setCopyState('pending');
    recoverEvent('copy');
    try {
      await navigator.clipboard.writeText(held.displayValue);
      recoverEvent('copied');
      if (current()?.token !== held.token || copyAttempt.current !== attempt) return;
      setCopyState('copied');
    } catch (error) {
      if (!['NotAllowedError', 'SecurityError'].includes(error?.name)) reportRoadmapFailure('roadmap-step-draft-copy', error);
      recoverEvent('copy_failed');
      if (current()?.token !== held.token || copyAttempt.current !== attempt) return;
      setCopyState('failed');
    }
  };
  const returnToStep = async () => {
    const held = current();
    if (!held || held.unavailable || returnState === 'pending') return;
    const returnToken = store.requestReturn(held.token);
    setReturnState('pending');
    recoverEvent('return');
    try {
      const result = await requestNavigation({ key: 'roadmap:draft:return', run: (tx) => {
        const latest = current();
        if (latest?.token !== held.token || latest.returnToken !== returnToken) return false;
        tx.pushEntry(held.route.pathname + held.route.search + held.route.hash, held.route.state);
        return true;
      } });
      if (current()?.token !== held.token) return;
      if (result.status !== 'completed' || result.value === false) throw new Error('Draft return cancelled');
      clearTimeout(returnTimer.current);
      returnTimer.current = setTimeout(() => {
        if (current()?.returnToken !== returnToken) return;
        store.update(held.token, { returnToken: null });
        setReturnState('failed');
        recoverEvent('return_failed');
        reportRoadmapFailure('roadmap-step-draft-return', new Error('Draft adoption timed out'));
      }, 10000);
    } catch (error) {
      if (current()?.token !== held.token) return;
      store.update(held.token, { returnToken: null });
      setReturnState('failed');
      recoverEvent('return_failed');
      reportRoadmapFailure('roadmap-step-draft-return', error);
    }
  };
  const controller = {
    store, slot, theme, input, launcher, viewButton, event, copy, copyState, openRecovery,
    registerRoom: (value) => { room.current = value; return () => { if (room.current === value) room.current = null; }; },
    start: (step, field, treeId, element) => {
      const held = current();
      if (held?.mode === 'retained') { recoverEvent('collision'); openRecovery(element); return; }
      if (held?.draft.stepId === step.id && held.draft.field === field) { input.current?.focus(); return; }
      requestNavigation({ key: `roadmap:field:${field}`, run: () => {
        const authority = room.current?.read();
        const latestStep = authority?.tree?.nodesById.get(step.id);
        if (!authority?.editable || !latestStep || current()) return;
        launcher.current = element;
        const value = fieldValue(latestStep, field);
        const token = store.start({ draft: new InlineStepDraft({ stepId: step.id, field, baselineValue: value }), treeId,
          route: readNavigation(), displayValue: room.current.display(field, value) });
        if (token) event('open', field);
      } });
    },
    change: (token, draft, displayValue) => store.update(token, { draft, displayValue }),
    cancel: () => {
      const held = current();
      return requestNavigation({ key: 'roadmap:field:cancel', run: () => {
        event('cancel', held?.draft.field);
        if (current()?.token === held?.token) finishEditor(held.token);
        else restoreLauncher(held);
      } });
    },
    finish: finishEditor,
    adopt: (token, returnToken) => {
      if (!store.adopt(token, returnToken)) return false;
      clearTimeout(returnTimer.current);
      setReturnState(null); setRecovery(null);
      recoverEvent('adopted');
      return true;
    },
    refuseReturn: (token) => {
      if (!store.update(token, { returnToken: null, unavailable: true })) return;
      clearTimeout(returnTimer.current);
      setReturnState('unavailable');
      recoverEvent('unavailable');
    },
  };
  return <DraftContext.Provider value={controller}>
    {children}
    {slot && recovery === slot.token && <DraftRecovery theme={theme} slot={slot} copyState={copyState} returnState={returnState} onClose={closeRecovery}
      onCopy={copy} onDiscard={askDiscard} onReturn={returnToStep} covered={!!decision} />}
    {slot && decision?.slotToken === slot.token && <DraftDecision theme={theme} retained={decision.mode === 'retained'} onKeep={keep} onDiscard={discard} />}
  </DraftContext.Provider>;
}

export function useStepDraft() { return useContext(DraftContext); }

export function StepDraftNotice() {
  const controller = useStepDraft();
  if (controller?.slot?.mode !== 'retained') return null;
  return <aside className="st-draft-notice">
    <div role="status"><strong>{t('roadmap.draft.title')}</strong><span>{t('roadmap.draft.notSaved')}</span></div>
    <span ref={controller.viewButton}><Button variant="secondary" onClick={(event) => controller.openRecovery(event.currentTarget)}>{t('roadmap.draft.view')}</Button></span>
  </aside>;
}

function DraftDecision({ theme, retained, onKeep, onDiscard }) {
  const layer = useRef(null);
  const keep = useRef(null);
  const viewport = useComposerViewport();
  useLayoutEffect(() => {
    const release = coverBeneath(layer.current);
    keep.current?.querySelector('button')?.focus();
    return release;
  }, []);
  return createPortal(<div ref={layer} style={viewport.style} data-theme={theme} className="st-draft-modal-layer st-draft-modal-layer--decision" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onKeep(); return; }
    wrapTab(event, layer.current);
  }}>
    <div className="st-draft-scrim" onClick={onKeep} />
    <section className="st-draft-decision" role="dialog" aria-modal="true" aria-labelledby="step-draft-decision">
      <h2 id="step-draft-decision">{t('roadmap.draft.discardTitle')}</h2>
      <p>{t('roadmap.draft.discardBody')}</p>
      <footer><Button variant="secondary" onClick={onDiscard}>{t('roadmap.draft.discard')}</Button>
        <span ref={keep}><Button variant="secondary" onClick={onKeep}>{retained ? t('roadmap.draft.keep') : t('roadmap.inline.keepEditing')}</Button></span></footer>
    </section>
  </div>, document.body);
}

function DraftRecovery({ theme, slot, copyState, returnState, onClose, onCopy, onDiscard, onReturn, covered }) {
  const layer = useRef(null);
  const heading = useRef(null);
  const content = useRef(null);
  const viewport = useComposerViewport();
  useLayoutEffect(() => { const release = coverBeneath(layer.current); heading.current.focus(); return release; }, []);
  return createPortal(<div ref={layer} style={viewport.style} data-theme={theme} className="st-draft-modal-layer" inert={covered ? '' : undefined} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    wrapTab(event, layer.current);
  }}>
    <div className="st-draft-scrim" onClick={onClose} />
    <section className="st-draft-recovery" role="dialog" aria-modal="true" aria-labelledby="step-draft-title">
      <header><h2 ref={heading} tabIndex={-1} id="step-draft-title">{t('roadmap.draft.title')}</h2><Button variant="secondary" onClick={onClose}>{t('roadmap.draft.close')}</Button></header>
      <div className="st-draft-recovery-body">
        <strong className="st-draft-meta">{t('roadmap.draft.fieldStatus', { field: fieldLabel(slot.draft.field) })}</strong>
        <p>{slot.unavailable ? t('roadmap.draft.unavailable') : t('roadmap.draft.retained')}</p>
        <textarea ref={content} readOnly aria-label={fieldLabel(slot.draft.field)} value={slot.displayValue} />
        <p role="status" className="st-draft-meta">{copyState === 'failed' ? t('roadmap.draft.copyFailed') : copyState === 'copied' ? t('roadmap.draft.copied') : ''}</p>
        <div className="st-draft-copy"><Button variant="secondary" disabled={copyState === 'pending'} onClick={copyState === 'failed' ? () => { content.current.focus(); content.current.select(); track('roadmap_step_draft', { step: 'select' }); } : onCopy}>{copyState === 'failed' ? t('roadmap.draft.select') : t('roadmap.draft.copy')}</Button>{copyState === 'failed' && !slot.unavailable && <Button variant="secondary" onClick={onCopy}>{t('roadmap.draft.tryAgain')}</Button>}</div>
        {returnState === 'failed' && <p role="status">{t('roadmap.draft.returnFailed')}</p>}
        <strong className="st-draft-meta">{t('roadmap.draft.reloadNotice')}</strong>
      </div>
      <footer><Button variant="secondary" onClick={onDiscard}>{t('roadmap.draft.discard')}</Button>
        {slot.unavailable ? <Button disabled={copyState === 'pending'} onClick={onCopy}>{copyState === 'failed' ? t('roadmap.draft.tryAgain') : t('roadmap.draft.copy')}</Button>
          : <Button disabled={returnState === 'pending'} onClick={onReturn}>{returnState === 'failed' ? t('roadmap.draft.tryAgain') : t('roadmap.draft.return')}</Button>}
      </footer>
    </section>
  </div>, document.body);
}
