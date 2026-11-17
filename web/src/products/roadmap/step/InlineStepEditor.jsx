import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { kindChoices } from '../model/Legend.js';
import { KindChoice } from '../board/BoardControls.jsx';
import { t } from '../i18n/index.js';
import { PrerequisiteChoices } from './StepDraft.js';
import { PickerSearch } from './PrerequisitePicker.jsx';
import { fieldValue, sameFieldValue } from './InlineStepDraft.js';
import { fieldLabel, useStepDraft } from './StepDraftProvider.jsx';

export function useInlineStepEditor({ treeId, tree, owner, loading, readAuthority, acts, legend, completed, stepId }) {
  const host = useStepDraft();
  const latest = useRef(null);
  const [failure, setFailure] = useState(null);
  const slot = host?.slot;
  const active = slot?.mode === 'active' && slot.treeId === treeId ? slot : null;
  const draft = active?.draft;
  const display = (field, value) => {
    if (field === 'color') return kindChoices(legend).find((kind) => kind.hue === value)?.label ?? value;
    if (field === 'prerequisites') return value.map((id) => tree?.nodesById.get(id)?.label ?? t('roadmap.inline.unnamed')).join('\n');
    return value;
  };
  latest.current = { read: readAuthority, display };
  useLayoutEffect(() => host?.registerRoom({ read: () => latest.current.read(), display: (...args) => latest.current.display(...args) }), [host?.store, treeId]);
  useLayoutEffect(() => {
    if (!slot || slot.treeId !== treeId || loading) return;
    const authority = readAuthority();
    const step = authority.tree?.nodesById.get(slot.draft.stepId);
    if (slot.mode === 'retained') {
      if (!slot.returnToken) return;
      if (!authority.editable || !step) { host.refuseReturn(slot.token); return; }
      if (slot.draft.stepId !== stepId) return;
      host.adopt(slot.token, slot.returnToken);
      return;
    }
    if (!authority.editable || !step) {
      if (!slot.unavailable) { host.store.update(slot.token, { unavailable: true }); host.event('unavailable'); }
      return;
    }
    if (slot.unavailable) return;
    const next = slot.draft.reconcile(authority.tree);
    if (next !== slot.draft) {
      host.change(slot.token, next, display(next.field, next.draftValue));
      host.event('selection_updated');
    }
  }, [host?.store, slot, tree, owner, loading, stepId]);
  if (!host) return null;
  const step = draft && readAuthority().tree?.nodesById.get(draft.stepId);
  const unavailable = Boolean(active && (active.unavailable || !owner || !step));
  const currentValue = step && draft ? fieldValue(step, draft.field) : null;
  const conflict = draft && !unavailable && !sameFieldValue(draft.field, currentValue, draft.baselineValue);
  const problem = failure && active && failure.token === active.token && failure.revision === draft.draftRevision ? failure : null;
  const change = (value) => {
    if (!active || unavailable || host.store.getSnapshot()?.token !== active.token) return;
    const next = draft.withValue(value);
    host.change(active.token, next, display(next.field, next.draftValue));
    if (['color', 'prerequisites'].includes(draft.field)) host.event('change');
  };
  const save = () => {
    const held = host.store.getSnapshot();
    if (!held || held.token !== active?.token || held.draft !== draft) return;
    const authority = readAuthority();
    if (!authority.editable || !authority.tree?.nodesById.has(draft.stepId) || held.unavailable) {
      host.store.update(held.token, { unavailable: true });
      host.event('unavailable');
      return;
    }
    if (authority.savingBlocked) return;
    let request;
    try { request = draft.request(conflict || problem?.kind === 'conflict' ? currentValue : draft.baselineValue); }
    catch { setFailure({ token: held.token, revision: draft.draftRevision, kind: 'name' }); host.event('invalid'); host.input.current?.focus(); return; }
    if (sameFieldValue(draft.field, request.value, draft.baselineValue)) {
      host.event('unchanged'); host.finish(held.token); return;
    }
    if (problem?.kind === 'save') host.event('retry');
    const result = acts.edit(request);
    if (!request.matches(host.store.getSnapshot()?.draft)) return;
    if (result.ok) { host.event('saved'); host.finish(held.token); return; }
    if (result.reason === 'unavailable') { host.store.update(held.token, { unavailable: true }); host.event('unavailable'); return; }
    if (result.reason === 'conflict') { setFailure({ token: held.token, revision: draft.draftRevision, kind: 'conflict' }); host.event('conflict'); return; }
    if (result.reason === 'stale') return;
    setFailure({ token: held.token, revision: draft.draftRevision, kind: 'save' });
    host.event('failed');
  };
  const loadLatest = () => {
    const authority = readAuthority();
    const latestStep = authority.tree?.nodesById.get(draft.stepId);
    if (!authority.editable || !latestStep || host.store.getSnapshot()?.token !== active.token) return;
    const next = draft.loadLatest(latestStep);
    host.change(active.token, next, display(next.field, next.draftValue));
    host.event('load_latest'); host.input.current?.focus();
  };
  return { host, active, draft, unavailable, conflict: conflict || problem?.kind === 'conflict',
    currentValue,
    problem, display, change, save, loadLatest, legend, tree, completed, savingBlocked: readAuthority().savingBlocked,
    start: (step, field, element) => host.start(step, field, treeId, element),
  };
}

export function InlineFieldTrigger({ editor, step, field, children, className = '' }) {
  if (!editor) return <span className={className}>{children}</span>;
  const labels = { label: t('roadmap.inline.editName'), description: t('roadmap.inline.editDescription'), color: t('roadmap.inline.editKind'), prerequisites: t('roadmap.inline.editPrerequisites') };
  return <button type="button" data-step-field={field} className={`st-inline-trigger ${className}`} aria-label={labels[field]}
    onClick={(event) => editor.start(step, field, event.currentTarget)}>{children}
    {field === 'label' ? <Pencil size={16} aria-hidden /> : field === 'color' ? <ChevronDown size={12} aria-hidden /> : field === 'prerequisites' ? <Plus size={16} aria-hidden /> : null}
  </button>;
}

export function InlineField({ editor, field }) {
  const id = useId();
  const root = useRef(null);
  const search = useRef(null);
  const [query, setQuery] = useState('');
  const { draft, host } = editor;
  const shown = draft?.field === field;
  useLayoutEffect(() => {
    if (!shown) return;
    const element = root.current?.querySelector('input, textarea, [role="radio"][aria-checked="true"], button');
    host.input.current = element;
    element?.focus({ preventScroll: true });
    return () => { if (host.input.current === element) host.input.current = null; };
  }, [shown, draft?.editId]);
  useEffect(() => {
    if (shown && editor.conflict) host.event('conflict');
  }, [shown, editor.conflict]);
  if (!shown) return null;
  const choices = field === 'prerequisites' ? new PrerequisiteChoices(editor.tree, editor.completed, { selected: draft.draftValue, query, editing: draft.stepId, limit: Infinity }) : null;
  return <div ref={root} className={`st-inline-field st-inline-field--${field}`} onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); host.cancel();
  }}>
    {(field === 'label' || field === 'color') && <label className="st-inline-label" htmlFor={id}>{fieldLabel(field)}</label>}
    {field === 'label' && <input id={id} value={draft.draftValue} autoComplete="off" aria-invalid={editor.problem?.kind === 'name'}
      aria-describedby={editor.problem?.kind === 'name' ? `${id}-error` : undefined} onChange={(event) => editor.change(event.target.value)} />}
    {field === 'description' && <textarea id={id} aria-label={fieldLabel(field)} value={draft.draftValue} onChange={(event) => editor.change(event.target.value)} />}
    {field === 'color' && <KindChoice kinds={kindChoices(editor.legend)} value={draft.draftValue} onChoose={editor.change} label={fieldLabel(field)} />}
    {choices && <>
      <p className="st-inline-prerequisite-intro">{t('roadmap.inline.choosePrerequisites')}</p>
      <PickerSearch inputRef={search} label={t('roadmap.inline.findStep')} value={query} onChange={setQuery} onClear={() => { setQuery(''); search.current.focus(); }} />
      <div className="st-inline-prerequisite-list">{choices.rows.map((row) => <button key={row.id} className="st-inline-prerequisite" type="button" role="checkbox" aria-checked={row.selected}
        onClick={() => editor.change(choices.toggle(row.id).selectedIds)}><span className="st-inline-check">{row.selected && <Check size={16} aria-hidden />}</span><span><strong>{row.label}</strong><small>{row.state}</small></span></button>)}</div>
      {draft.selectionUpdated && <div className="st-inline-notice" role="status"><strong>{t('roadmap.inline.selectionUpdated')}</strong><p>{t('roadmap.inline.selectionBody')}</p></div>}
    </>}
    {editor.problem?.kind === 'name' && <p id={`${id}-error`} role="alert">{t('roadmap.inline.nameRequired')}</p>}
    {editor.problem?.kind === 'save' && <p role="alert">{t('roadmap.inline.saveFailed')}</p>}
    {editor.conflict && <div className="st-inline-notice" role="status"><strong>{t('roadmap.inline.changed')}</strong><p>{t('roadmap.inline.conflict')}</p><p>{t('roadmap.inline.latest', { value: editor.display(field, editor.currentValue) || t('roadmap.inline.emptyValue') })}</p><Button variant="secondary" onClick={editor.loadLatest}>{t('roadmap.inline.loadLatest')}</Button></div>}
    <InlineFieldActions editor={editor} inline />
  </div>;
}

export function InlineFieldActions({ editor, inline = false }) {
  return <div className={inline ? 'st-inline-actions st-inline-actions--inline' : 'st-inline-actions st-inline-actions--pinned'}>
    <Button variant="secondary" onClick={editor.host.cancel}>{t('roadmap.inline.cancel')}</Button>
    <Button onClick={editor.save} disabled={editor.savingBlocked}>{editor.conflict ? t('roadmap.inline.saveAnyway') : t('roadmap.inline.save')}</Button>
  </div>;
}

export function UnavailableStepDraft({ editor, onClose }) {
  const field = useRef(null);
  return <section className="st-board-step-layer st-unavailable-draft" aria-label={t('roadmap.draft.title')}>
    <header><h2>{t('roadmap.draft.title')}</h2><Button variant="secondary" onClick={onClose}>{t('roadmap.draft.close')}</Button></header>
    <div className="st-draft-recovery-body"><strong className="st-draft-meta">{t('roadmap.draft.fieldStatus', { field: fieldLabel(editor.draft.field) })}</strong>
      <p>{t('roadmap.inline.unavailable')}</p><textarea ref={field} readOnly aria-label={fieldLabel(editor.draft.field)} value={editor.active.displayValue} />
      {editor.host.copyState === 'failed' && <><p role="status">{t('roadmap.draft.copyFailed')}</p><Button variant="secondary" onClick={() => { field.current.focus(); field.current.select(); track('roadmap_step_draft', { step: 'select' }); }}>{t('roadmap.draft.select')}</Button></>}
      {editor.host.copyState === 'copied' && <p role="status">{t('roadmap.draft.copied')}</p>}
      <strong className="st-draft-meta">{t('roadmap.draft.reloadNotice')}</strong></div>
    <footer><Button variant="secondary" onClick={onClose}>{t('roadmap.draft.close')}</Button><Button disabled={editor.host.copyState === 'pending'} onClick={editor.host.copy}>{editor.host.copyState === 'failed' ? t('roadmap.draft.tryAgain') : t('roadmap.draft.copy')}</Button></footer>
  </section>;
}
