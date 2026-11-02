import React, { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, Italic, Link, List } from 'lucide-react';
import { Icon } from '../../../design-system/Icon.jsx';
import { track } from '../../../telemetry/beacon.js';
import { formatNote } from '../model/NodeWorkspace.js';
import { renderMarkdown, SAFE_URL } from '../ui/tree/NodeWorkspace.jsx';
import { ActivityLog } from '../activity/ActivityLog.js';
import { ActorAvatar, EventSentence, relativeTime } from '../activity/grammar.jsx';
import { DiscardDraft, useComposerViewport } from './StepComposer.jsx';
import { useComposerFocus } from './composerFocus.js';
import { WORKSPACE, WORKSPACE_EMPTY, NEW_LINK, HISTORY_EMPTY, NOTE_EDITOR, STEP_DETAIL, subtaskTally } from './copy.js';
import './workspace.css';

const FORMATS = [['bold', Bold], ['italic', Italic], ['link', Link], ['list', List]];
const workspaceEvent = (action) => track('roadmap_board_workspace', { action });

export const StepWorkspace = forwardRef(function StepWorkspace({ nodeId, title, workspace, actions, phone, onEditing, onChecked, onEditNote }, ref) {
  const subtasks = workspace?.subtasks ?? [];
  const note = workspace?.note ?? '';
  const links = (workspace?.links ?? []).filter((link) => SAFE_URL.test(link.url));
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const opener = useRef(null);
  const panel = useRef(null);
  const editor = useRef(null);
  const returnLabel = useRef(null);
  const returnPinned = useRef(false);
  const layer = useRef(null);
  const taskInput = useRef(null);

  const openNote = () => {
    opener.current = document.activeElement;
    returnLabel.current = document.activeElement?.textContent;
    returnPinned.current = Boolean(document.activeElement?.closest('.st-board-step-page-pinned'));
    layer.current = panel.current?.closest('.st-board-step-layer');
    setEditing(true);
    onEditing(true);
    onEditNote();
  };
  const closeNote = () => {
    setEditing(false);
    onEditing(false);
    requestAnimationFrame(() => {
      const buttons = [...(layer.current?.querySelectorAll('button') ?? [])];
      const replacement = buttons.find((button) => button.textContent === returnLabel.current)
        ?? (returnPinned.current ? buttons.find((button) => button.closest('.st-board-step-page-pinned') && button.textContent === STEP_DETAIL.editNote) : null)
        ?? buttons.find((button) => button.textContent === WORKSPACE.edit);
      const fallback = layer.current?.querySelector('.st-board-step-status') ?? layer.current?.querySelector('[role="dialog"]');
      (opener.current?.isConnected ? opener.current : replacement ?? fallback)?.focus({ preventScroll: true });
    });
  };
  useImperativeHandle(ref, () => ({ openNote, close: () => editor.current?.cancel() }));
  useEffect(() => {
    if (addingTask) taskInput.current?.focus();
  }, [addingTask]);

  if (editing) {
    return <NoteEditor ref={editor} layerBounds={layer.current?.getBoundingClientRect()} note={note} title={title} phone={phone} onCancel={closeNote} onSave={(text) => {
      actions.onSetNote(nodeId, text);
      workspaceEvent('noteSave');
      closeNote();
    }} />;
  }
  const empty = subtasks.length === 0 && !note && links.length === 0;
  const commitTask = () => {
    const label = taskDraft.trim();
    if (!label) {
      setAddingTask(false);
      return;
    }
    actions.onAddSubtask(nodeId, label);
    workspaceEvent('subtaskAdd');
    setTaskDraft('');
  };
  const addLink = <button type="button" className="st-board-workspace-text" data-add-link onClick={() => setAddingLink(true)}>+ {WORKSPACE.addLink}</button>;
  return (
    <div ref={panel} className="st-board-workspace">
      {(subtasks.length > 0 || addingTask) && <section className="st-board-workspace-tasks">
        <h3 className="st-board-workspace-tally"><span>{WORKSPACE.subtasks}</span><span>{subtaskTally({ done: subtasks.filter((item) => item.done).length, total: subtasks.length })}</span></h3>
        <div className="st-board-workspace-task-list">
          {subtasks.map((item) => <div key={item.id} className="st-board-workspace-task">
            <label>
              <input type="checkbox" checked={item.done} onChange={() => {
                actions.onToggleSubtask(nodeId, item.id);
                workspaceEvent('subtaskToggle');
                onChecked(item);
              }} />
              <span className="st-board-workspace-check" aria-hidden>{item.done && <Icon name="check" size={12} />}</span>
              <span className={item.done ? 'is-done' : undefined}>{item.label}</span>
            </label>
            <button type="button" className="st-board-workspace-remove" aria-label={WORKSPACE.removeSubtask} onClick={() => {
              actions.onDeleteSubtask(nodeId, item.id);
              workspaceEvent('subtaskDelete');
            }}><Icon name="x" size={13} /></button>
          </div>)}
          {addingTask ? <form onSubmit={(event) => { event.preventDefault(); commitTask(); }}>
            <input ref={taskInput} aria-label={WORKSPACE.addSubtask} value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setAddingTask(false);
              setTaskDraft('');
              requestAnimationFrame(() => panel.current?.querySelector('.st-board-workspace-add-task')?.focus());
            }} />
          </form> : <button type="button" className="st-board-workspace-text st-board-workspace-add-task" onClick={() => setAddingTask(true)}><Icon name="plus" size={13} />{WORKSPACE.addSubtask}</button>}
        </div>
      </section>}
      {note && <section>
        <div className="st-board-workspace-note-heading"><h3>{WORKSPACE.note}</h3><button type="button" className="st-board-workspace-text" onClick={openNote}>{WORKSPACE.edit}</button></div>
        <div className="st-board-workspace-note">{renderMarkdown(note)}</div>
      </section>}
      {(links.length > 0 || addingLink) && <section className="st-board-workspace-links">
        <h3>{WORKSPACE.personalLinks}</h3>
        {links.map((link) => <div key={link.id} className="st-board-workspace-link">
          <a href={link.url} target="_blank" rel="noopener noreferrer"><span>{link.title || link.url}</span><Icon name="external-link" size={14} /></a>
          <button type="button" className="st-board-workspace-remove" aria-label={WORKSPACE.removeLink} onClick={() => {
            actions.onDeleteLink(nodeId, link.id);
            workspaceEvent('linkDelete');
          }}><Icon name="x" size={14} /></button>
        </div>)}
        {addingLink ? <LinkEditor title={NEW_LINK.title} personal onCancel={() => setAddingLink(false)} onApply={({ text, url }) => {
          actions.onAddLink(nodeId, { url, title: text });
          workspaceEvent('linkAdd');
          setAddingLink(false);
        }} /> : addLink}
      </section>}
      {(subtasks.length === 0 || !note || links.length === 0) && <div className="st-board-workspace-missing">
        {empty && !addingTask && !addingLink && <p>{WORKSPACE_EMPTY.body}</p>}
        <div>
          {subtasks.length === 0 && !addingTask && <button type="button" className="st-board-step-action st-board-step-action--secondary st-board-workspace-add-task" onClick={() => setAddingTask(true)}>+ {WORKSPACE.addSubtask}</button>}
          {!note && <button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={openNote}>+ {WORKSPACE_EMPTY.addNote}</button>}
          {links.length === 0 && !addingLink && <button type="button" className="st-board-step-action st-board-step-action--secondary" data-add-link onClick={() => setAddingLink(true)}>+ {WORKSPACE.addLink}</button>}
        </div>
      </div>}
    </div>
  );
});

export function StepHistory({ history, nodeId, phone, now = Date.now() }) {
  const groups = new ActivityLog(history).groupedForNode(nodeId, now);
  return <div className="st-board-workspace-history">
    {phone && <h3>{STEP_DETAIL.sections.history}</h3>}
    {groups.length === 0 && <p className="st-board-workspace-empty-history">{HISTORY_EMPTY}</p>}
    {groups.map((group) => <section key={group.label}>
      <h3 className="st-board-workspace-day">{group.label}</h3>
      {group.events.map((event) => <div key={event.id} className="st-board-workspace-event">
        <ActorAvatar event={event} size={22} />
        <span><EventSentence event={event} node={null} /></span>
        <time dateTime={event.at == null ? undefined : new Date(event.at).toISOString()}>{relativeTime(event.at, now)}</time>
      </div>)}
    </section>)}
  </div>;
}

function LinkEditor({ title, text = '', personal = false, onApply, onCancel }) {
  const [label, setLabel] = useState(text);
  const [url, setUrl] = useState('');
  const box = useRef(null);
  const textId = useId();
  const urlId = useId();
  const headingId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    const parent = box.current.closest('.st-board-step-layer');
    box.current.querySelector('input[type="url"]').focus();
    return () => {
      requestAnimationFrame(() => {
        const replacement = parent?.querySelector('[data-add-link]') ?? parent?.querySelector('.st-board-note-writing') ?? parent?.querySelector('[role="dialog"]');
        (opener?.isConnected && opener !== document.body ? opener : replacement)?.focus({ preventScroll: true });
      });
    };
  }, []);
  let valid = false;
  try { valid = SAFE_URL.test(url.trim()) && (!personal || /^https?:/i.test(url.trim())) && Boolean(new URL(url.trim())); } catch { valid = false; }
  return <form ref={box} className="st-board-note-link-editor" aria-labelledby={headingId} onSubmit={(event) => {
    event.preventDefault();
    if (valid) onApply({ text: label.trim(), url: url.trim() });
  }} onKeyDown={(event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }}>
    <div className="st-board-note-link-actions"><h3 id={headingId}>{title}</h3><button type="button" onClick={onCancel}>{NOTE_EDITOR.cancel}</button><button type="submit" className="st-board-note-apply" disabled={!valid}>{NOTE_EDITOR.apply}</button></div>
    <div><label htmlFor={textId}>{NOTE_EDITOR.text}</label><input id={textId} value={label} onChange={(event) => setLabel(event.target.value)} /></div>
    <div><label htmlFor={urlId}>{NOTE_EDITOR.url}</label><input id={urlId} type="url" value={url} placeholder={NOTE_EDITOR.urlPlaceholder} onChange={(event) => setUrl(event.target.value)} /></div>
  </form>;
}

const NoteEditor = forwardRef(function NoteEditor({ note, title, phone, layerBounds, onCancel, onSave }, ref) {
  const [draft, setDraft] = useState(note);
  const [rendered, setRendered] = useState({ text: note, revision: 0 });
  const [discarding, setDiscarding] = useState(false);
  const [link, setLink] = useState(null);
  const [typingFormat, setTypingFormat] = useState(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const writing = useRef(null);
  const box = useRef(null);
  const selectionRef = useRef(selection);
  const initial = useRef(note);
  const focus = useComposerFocus(box, !discarding);
  const viewport = useComposerViewport(phone);
  const bounds = box.current?.closest('.st-board-step-layer')?.getBoundingClientRect() ?? layerBounds;
  const visible = viewport.style;
  const viewportStyle = phone && visible && bounds ? {
    position: 'absolute',
    top: Math.max(0, visible.top - bounds.top),
    left: Math.max(0, visible.left - bounds.left),
    width: Math.max(0, Math.min(bounds.right, visible.left + visible.width) - Math.max(bounds.left, visible.left)),
    height: Math.max(0, Math.min(bounds.bottom, visible.top + visible.height) - Math.max(bounds.top, visible.top)),
    bottom: 'auto',
    right: 'auto',
  } : undefined;
  const blocks = useMemo(() => renderMarkdown(rendered.text), [rendered]);
  const cancel = () => {
    if (draft !== initial.current) {
      setDiscarding(true);
      return;
    }
    onCancel();
  };
  useImperativeHandle(ref, () => ({ cancel }));
  useLayoutEffect(() => {
    const root = writing.current;
    root.focus();
    const { positions } = readNote(root);
    if (positions.length === 0) {
      const range = document.createRange();
      range.selectNodeContents(root.querySelector('li, p') ?? root);
      range.collapse(false);
      const selected = window.getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
      return;
    }
    const locate = (offset) => positions.reduce((closest, point) => Math.abs(point.markdown - offset) < Math.abs(closest.markdown - offset) ? point : closest);
    const start = locate(selectionRef.current.start);
    const end = locate(selectionRef.current.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const browserSelection = window.getSelection();
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
  }, [rendered]);
  const read = (changed = false) => {
    const current = readNote(writing.current);
    if (changed) setDraft(current.text);
    setSelection(current.selection);
    selectionRef.current = current.selection;
    return current;
  };
  const apply = (format) => {
    if (['bold', 'italic'].includes(format) && selectionRef.current.start === selectionRef.current.end) {
      setTypingFormat((current) => current === format ? null : format);
      writing.current.focus();
      return;
    }
    setTypingFormat(null);
    const current = readNote(writing.current);
    const result = formatNote(current.text, selectionRef.current, format);
    setDraft(result.text);
    setSelection(result.selection);
    selectionRef.current = result.selection;
    setRendered((current) => ({ text: result.text, revision: current.revision + 1 }));
  };
  const toolbar = <div className="st-board-note-toolbar">
    {FORMATS.map(([kind, Glyph]) => {
      const before = draft.slice(0, selection.start);
      const after = draft.slice(selection.end);
      const activeMarker = before.endsWith('**') && after.startsWith('**') ? 'bold'
        : before.endsWith('*') && after.startsWith('*') ? 'italic' : null;
      const pressed = typingFormat === kind || (kind === 'link' ? link !== null : kind === 'list'
        ? draft.slice(draft.lastIndexOf('\n', selection.start - 1) + 1).startsWith('- ')
        : activeMarker === kind);
      return <button key={kind} type="button" aria-label={NOTE_EDITOR[kind]} aria-pressed={pressed} onPointerDown={(event) => event.preventDefault()} onClick={() => {
        if (kind === 'link') {
          const current = readNote(writing.current);
          setLink({ text: current.text.slice(selectionRef.current.start, selectionRef.current.end) });
          return;
        }
        apply(kind);
      }}><Glyph size={20} strokeWidth={2} aria-hidden /></button>;
    })}
    {phone && <button type="button" className="st-board-note-save" onClick={() => onSave(draft)}>{NOTE_EDITOR.save}</button>}
  </div>;
  return <div ref={box} style={viewportStyle} className={`st-board-note-editor${phone ? ' st-board-note-editor--phone' : ''}`} tabIndex={-1} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    focus(event);
  }}>
    <div className="st-board-note-header">
      {phone && !link && <button type="button" onClick={cancel}>{NOTE_EDITOR.cancel}</button>}
      <div><h3>{NOTE_EDITOR.title}</h3>{phone && <p>{title}</p>}</div>
    </div>
    <div className="st-board-note-box" inert={discarding ? '' : undefined}>
      {!phone && toolbar}
      <div key={rendered.revision} ref={writing} role="textbox" aria-label={WORKSPACE.note} aria-multiline="true" contentEditable tabIndex={0} suppressContentEditableWarning className="st-board-note-writing" onBeforeInput={(event) => {
        if (!typingFormat || !event.data) return;
        event.preventDefault();
        const current = readNote(writing.current);
        const start = current.selection.start;
        const inserted = current.text.slice(0, start) + event.data + current.text.slice(current.selection.end);
        const result = formatNote(inserted, { start, end: start + event.data.length }, typingFormat);
        const caret = { start: result.selection.end, end: result.selection.end };
        selectionRef.current = caret;
        setSelection(caret);
        setDraft(result.text);
        setRendered((previous) => ({ text: result.text, revision: previous.revision + 1 }));
        setTypingFormat(null);
      }} onInput={() => read(true)} onSelect={() => read()} onKeyUp={() => read()} onMouseUp={() => read()} onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        const selected = window.getSelection();
        if (!selected.rangeCount) return;
        const range = selected.getRangeAt(0);
        range.deleteContents();
        const inserted = document.createTextNode(text);
        range.insertNode(inserted);
        range.setStartAfter(inserted);
        range.collapse(true);
        selected.removeAllRanges();
        selected.addRange(range);
        read(true);
      }}>{blocks}</div>
      {link ? <LinkEditor title={NOTE_EDITOR.link} text={link.text} onCancel={() => {
        setLink(null);
        setRendered((current) => ({ text: draft, revision: current.revision + 1 }));
      }} onApply={({ text, url }) => {
        apply({ kind: 'link', text, url });
        setLink(null);
      }} /> : phone && toolbar}
    </div>
    {!phone && <div className="st-board-note-actions" inert={discarding ? '' : undefined}>
      <button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={cancel}>{NOTE_EDITOR.cancel}</button>
      <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={() => onSave(draft)}>{NOTE_EDITOR.save}</button>
    </div>}
    {discarding && <DiscardDraft phone={phone} onKeep={() => setDiscarding(false)} onDiscard={() => {
      workspaceEvent('noteDiscard');
      onCancel();
    }} />}
  </div>;
});

function readNote(root) {
  const selection = window.getSelection();
  const range = selection.rangeCount && root.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  const positions = [];
  let text = '';
  let start = 0;
  let end = 0;
  const serialize = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (let offset = 0; offset <= node.data.length; offset += 1) {
        positions.push({ node, offset, markdown: text.length + offset });
      }
      if (range?.startContainer === node) start = text.length + range.startOffset;
      if (range?.endContainer === node) end = text.length + range.endOffset;
      text += node.data;
      return;
    }
    const tag = node.nodeName;
    const marker = ['STRONG', 'B'].includes(tag) ? '**' : ['EM', 'I'].includes(tag) ? '*' : '';
    const link = tag === 'A' && SAFE_URL.test(node.getAttribute('href') ?? '') ? node.getAttribute('href') : null;
    if (marker) text += marker;
    if (link) text += '[';
    if (tag === 'LI') text += '- ';
    if (tag === 'BR') text += '\n';
    [...node.childNodes].forEach((child, index) => {
      if (range?.startContainer === node && range.startOffset === index) start = text.length;
      if (range?.endContainer === node && range.endOffset === index) end = text.length;
      serialize(child);
    });
    if (range?.startContainer === node && range.startOffset === node.childNodes.length) start = text.length;
    if (range?.endContainer === node && range.endOffset === node.childNodes.length) end = text.length;
    if (marker) text += marker;
    if (link) text += `](${link})`;
    if (tag === 'LI' && node.nextSibling) text += '\n';
    if (node !== root && ['P', 'DIV', 'UL'].includes(tag) && node.nextSibling) {
      text += tag === 'DIV' ? '\n' : tag === 'UL' ? '\n' : '\n\n';
    }
  };
  serialize(root);
  return { text, selection: { start, end }, positions };
}
