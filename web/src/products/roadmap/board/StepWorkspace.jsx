import React, { forwardRef, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Link, List } from 'lucide-react';
import { Icon } from '../../../design-system/Icon.jsx';
import { track } from '../../../telemetry/beacon.js';
import { formatNote, NoteDocument } from '../model/NodeWorkspace.js';
import { renderMarkdown, SAFE_URL } from '../ui/tree/NodeWorkspace.jsx';
import { ActivityLog } from '../activity/ActivityLog.js';
import { ActorAvatar, EventSentence, relativeTime } from '../activity/grammar.jsx';
import { DiscardDraft } from './DiscardDraft.jsx';
import { coverBeneath, DetailFocusContext, useComposerFocus, useComposerViewport } from './composerFocus.js';
import { WORKSPACE, WORKSPACE_EMPTY, NEW_LINK, HISTORY_EMPTY, NOTE_EDITOR, STEP_DETAIL, subtaskTally } from './copy.js';
import './workspace.css';

const FORMATS = [['bold', Bold], ['italic', Italic], ['link', Link], ['list', List]];
const workspaceEvent = (action) => track('roadmap_board_workspace', { action });

export const StepWorkspace = forwardRef(function StepWorkspace({ nodeId, title, workspace, actions, phone, onEditing, onChecked, onEditNote }, ref) {
  const subtasks = workspace?.subtasks ?? [];
  const note = workspace?.note ?? '';
  const links = (workspace?.links ?? []).filter((link) => SAFE_URL.test(link.url));
  const [editing, setEditing] = useState(null);
  const [addingTask, setAddingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const focus = useContext(DetailFocusContext);
  const panel = useRef(null);
  const editor = useRef(null);
  const noteOpener = useRef(null);
  const linkOpener = useRef(null);
  const taskOpener = useRef(null);
  const taskInput = useRef(null);
  const openNote = (opener = noteOpener) => {
    setEditing({ note, opener, bounds: panel.current?.closest('.st-board-step-layer')?.getBoundingClientRect() });
    onEditing(true);
    onEditNote();
  };
  const closeNote = () => {
    const opener = editing.opener;
    setEditing(null);
    onEditing(false);
    focus?.restore(opener);
  };
  const closeLink = () => {
    setAddingLink(false);
    focus?.restore(linkOpener);
  };
  const closeTask = () => {
    setAddingTask(false);
    setTaskDraft('');
    focus?.restore(taskOpener);
  };
  useImperativeHandle(ref, () => ({ openNote, close: () => editor.current?.cancel() }));
  useEffect(() => {
    if (addingTask) taskInput.current?.focus();
  }, [addingTask]);

  if (editing) {
    return (
      <NoteEditor
        ref={editor}
        layerBounds={editing.bounds}
        note={editing.note}
        title={title}
        phone={phone}
        onCancel={closeNote}
        onSave={(text) => {
          if (text !== editing.note) {
            actions.onSetNote(nodeId, text);
            workspaceEvent('noteSave');
          }
          closeNote();
        }}
      />
    );
  }
  const empty = subtasks.length === 0 && !note && links.length === 0;
  const commitTask = () => {
    const label = taskDraft.trim();
    if (!label) {
      closeTask();
      return;
    }
    actions.onAddSubtask(nodeId, label);
    workspaceEvent('subtaskAdd');
    setTaskDraft('');
  };
  const addLink = (
    <button ref={linkOpener} type="button" className="st-board-workspace-text" data-add-link onClick={() => setAddingLink(true)}>
      <Icon name="plus" size={13} />{WORKSPACE.addLink}
    </button>
  );
  return (
    <div ref={panel} className="st-board-workspace">
      {(subtasks.length > 0 || addingTask) && (
        <section className="st-board-workspace-tasks">
          <h3 className="st-board-workspace-tally">
            <span>{WORKSPACE.subtasks}</span>
            <span>{subtaskTally({ done: subtasks.filter((item) => item.done).length, total: subtasks.length })}</span>
          </h3>
          <div className="st-board-workspace-task-list">
            {subtasks.map((item) => (
              <div key={item.id} className="st-board-workspace-task">
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
              </div>
            ))}
            {addingTask ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                commitTask();
              }}>
                <input ref={taskInput} aria-label={WORKSPACE.addSubtask} value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeTask();
                }} />
              </form>
            ) : (
              <button ref={taskOpener} type="button" className="st-board-workspace-text st-board-workspace-add-task" onClick={() => setAddingTask(true)}>
                <Icon name="plus" size={13} />{WORKSPACE.addSubtask}
              </button>
            )}
          </div>
        </section>
      )}
      {note && (
        <section>
          <div className="st-board-workspace-note-heading">
            <h3>{WORKSPACE.note}</h3>
            <button ref={noteOpener} type="button" className="st-board-workspace-text" onClick={() => openNote()}>{WORKSPACE.edit}</button>
          </div>
          <div className="st-board-workspace-note">{renderMarkdown(note)}</div>
        </section>
      )}
      {(links.length > 0 || addingLink) && (
        <section className="st-board-workspace-links">
          <h3>{WORKSPACE.personalLinks}</h3>
          {links.map((link) => (
            <div key={link.id} className="st-board-workspace-link">
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                <span>{link.title || link.url}</span><Icon name="external-link" size={14} />
              </a>
              <button type="button" className="st-board-workspace-remove" aria-label={WORKSPACE.removeLink} onClick={() => {
                actions.onDeleteLink(nodeId, link.id);
                workspaceEvent('linkDelete');
              }}><Icon name="x" size={14} /></button>
            </div>
          ))}
          {addingLink ? (
            <LinkEditor title={NEW_LINK.title} personal onCancel={closeLink} onApply={({ text, url }) => {
              actions.onAddLink(nodeId, { url, title: text });
              workspaceEvent('linkAdd');
              closeLink();
            }} />
          ) : addLink}
        </section>
      )}
      {(subtasks.length === 0 || !note || links.length === 0) && (
        <div className="st-board-workspace-missing">
          {empty && !addingTask && !addingLink && <p>{WORKSPACE_EMPTY.body}</p>}
          <div>
            {subtasks.length === 0 && !addingTask && (
              <button ref={taskOpener} type="button" className="st-board-step-action st-board-step-action--secondary st-board-workspace-add-task" onClick={() => setAddingTask(true)}>
                <Icon name="plus" size={16} />{WORKSPACE.addSubtask}
              </button>
            )}
            {!note && (
              <button ref={noteOpener} type="button" className="st-board-step-action st-board-step-action--secondary" onClick={() => openNote()}>
                <Icon name="plus" size={16} />{WORKSPACE_EMPTY.addNote}
              </button>
            )}
            {links.length === 0 && !addingLink && (
              <button ref={linkOpener} type="button" className="st-board-step-action st-board-step-action--secondary" data-add-link onClick={() => setAddingLink(true)}>
                <Icon name="plus" size={16} />{WORKSPACE.addLink}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export function StepHistory({ history, nodeId, phone, now = Date.now() }) {
  const groups = new ActivityLog(history).groupedForNode(nodeId, now);
  return (
    <div className="st-board-workspace-history">
      {phone && <h3 className="st-board-workspace-history-title">{STEP_DETAIL.sections.history}</h3>}
      {groups.length === 0 && <p className="st-board-workspace-empty-history">{HISTORY_EMPTY}</p>}
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="st-board-workspace-day">{group.label}</h3>
          {group.events.map((event) => (
            <div key={event.id} className="st-board-workspace-event">
              <ActorAvatar event={event} size={22} />
              <span><EventSentence event={event} node={null} /></span>
              <time dateTime={event.at == null ? undefined : new Date(event.at).toISOString()}>{relativeTime(event.at, now)}</time>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function LinkEditor({ title, text = '', personal = false, onApply, onCancel }) {
  const [label, setLabel] = useState(text);
  const [url, setUrl] = useState('');
  const box = useRef(null);
  const textId = useId();
  const urlId = useId();
  const headingId = useId();
  useEffect(() => {
    box.current.querySelector('input[type="url"]').focus();
  }, []);
  let valid = false;
  try {
    const parsed = new URL(url.trim());
    valid = SAFE_URL.test(parsed.protocol) && (!personal || ['http:', 'https:'].includes(parsed.protocol));
  } catch {
    valid = false;
  }
  return (
    <form
      ref={box}
      className="st-board-note-link-editor"
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply({ text: label.trim(), url: url.trim() });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <div className="st-board-note-link-actions">
        <h3 id={headingId}>{title}</h3>
        <button type="button" onClick={onCancel}>{NOTE_EDITOR.cancel}</button>
        <button type="submit" className="st-board-note-apply" disabled={!valid}>{NOTE_EDITOR.apply}</button>
      </div>
      <div>
        <label htmlFor={textId}>{NOTE_EDITOR.text}</label>
        <input id={textId} value={label} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div>
        <label htmlFor={urlId}>{NOTE_EDITOR.url}</label>
        <input id={urlId} type="url" value={url} placeholder={NOTE_EDITOR.urlPlaceholder} onChange={(event) => setUrl(event.target.value)} />
      </div>
    </form>
  );
}

const NoteEditor = forwardRef(function NoteEditor({ note, title, phone, layerBounds, onCancel, onSave }, ref) {
  const documentRef = useRef(new NoteDocument(note));
  const [rendered, setRendered] = useState({ text: note, revision: 0 });
  const [discarding, setDiscarding] = useState(false);
  const [link, setLink] = useState(null);
  const [typingFormat, setTypingFormat] = useState(null);
  const [selection, setSelection] = useState({ start: note.length, end: note.length });
  const writing = useRef(null);
  const box = useRef(null);
  const discardLayer = useRef(null);
  const selectionRef = useRef(selection);
  const beforeInput = useRef(null);
  const composing = useRef(false);
  const initial = useRef(note);
  const focusContext = useContext(DetailFocusContext);
  const focus = useComposerFocus(box, !discarding, { restore: false });
  const viewport = useComposerViewport(phone);
  useLayoutEffect(() => {
    if (discarding) return coverBeneath(discardLayer.current);
  }, [discarding]);
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
  const blocks = useMemo(() => renderMarkdown(rendered.text, { sourceMap: true }), [rendered]);
  const redraw = (nextSelection) => {
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    setRendered((current) => ({ text: documentRef.current.text, revision: current.revision + 1 }));
  };
  const cancel = () => {
    if (documentRef.current.text !== initial.current) {
      setDiscarding(true);
      return;
    }
    onCancel();
  };
  const save = () => onSave(documentRef.current.text);
  useImperativeHandle(ref, () => ({ cancel }));
  useLayoutEffect(() => {
    const root = writing.current;
    root.focus();
    const projection = readNote(root);
    documentRef.current.project(projection);
    const positions = projection.positions;
    const locate = (offset) => positions.reduce((closest, point) => {
      if (point.source === null) return closest;
      if (!closest || Math.abs(point.source - offset) < Math.abs(closest.source - offset)) return point;
      return closest;
    }, null);
    const start = locate(selectionRef.current.start);
    const end = locate(selectionRef.current.end);
    const range = document.createRange();
    if (start && end) {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } else {
      range.selectNodeContents(root.querySelector('p, li') ?? root);
      range.collapse(false);
    }
    const selected = window.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
    const capture = (event) => {
      const current = readNote(root);
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        const restored = documentRef.current.undo(event.inputType === 'historyRedo', selectionRef.current);
        if (restored) redraw(restored);
        return;
      }
      if (['insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
        event.preventDefault();
        const selected = current.selection.source ?? documentRef.current.sourceSelection(current.selection);
        const range = window.getSelection()?.getRangeAt(0);
        const tokensAt = (container) => {
          const tokens = [];
          let node = container?.nodeType === 1 ? container : container?.parentElement;
          while (node && node !== root) {
            if (node.matches('[data-note-content-start][data-note-content-end]')) {
              tokens.push({
                start: Number(node.dataset.noteStart), end: Number(node.dataset.noteEnd),
                contentStart: Number(node.dataset.noteContentStart),
                contentEnd: Number(node.dataset.noteContentEnd),
              });
            }
            node = node.parentElement;
          }
          return tokens;
        };
        const tokens = { start: tokensAt(range?.startContainer), end: tokensAt(range?.endContainer) };
        redraw(documentRef.current.lineBreak(selected, tokens, event.inputType === 'insertParagraph'));
        return;
      }
      beforeInput.current = current.selection;
      if (composing.current) beforeInput.current.source = documentRef.current.sourceSelection(current.selection);
    };
    root.addEventListener('beforeinput', capture);
    return () => root.removeEventListener('beforeinput', capture);
  }, [rendered]);
  const readSelection = () => {
    const projection = readNote(writing.current);
    const current = composing.current
      ? documentRef.current.sourceSelection(projection.selection)
      : projection.selection.source ?? documentRef.current.sourceSelection(projection.selection);
    selectionRef.current = current;
    setSelection(current);
  };
  const input = (event) => {
    const projection = readNote(writing.current);
    const current = documentRef.current.change(projection, beforeInput.current);
    beforeInput.current = null;
    selectionRef.current = current;
    setSelection(current);
    if (event.nativeEvent.isComposing || composing.current) return;
    redraw(current);
  };
  const apply = (format) => {
    const { kind } = format;
    if (['bold', 'italic'].includes(kind) && selectionRef.current.start === selectionRef.current.end) {
      setTypingFormat((current) => current === kind ? null : kind);
      focusContext?.restore(writing);
      return;
    }
    setTypingFormat(null);
    const result = formatNote(documentRef.current.text, selectionRef.current, format);
    documentRef.current.replace(result.text, selectionRef.current);
    redraw(result.selection);
  };
  const closeLink = () => {
    setLink(null);
    redraw(selectionRef.current);
  };
  const toolbar = (
    <div className="st-board-note-toolbar">
      {FORMATS.map(([kind, Glyph]) => {
        const draft = documentRef.current.text;
        const before = draft.slice(0, selection.start);
        const after = draft.slice(selection.end);
        let activeMarker = null;
        if (before.endsWith('**') && after.startsWith('**')) activeMarker = 'bold';
        else if (before.endsWith('*') && after.startsWith('*')) activeMarker = 'italic';
        let pressed = typingFormat === kind || activeMarker === kind;
        if (kind === 'link') pressed = link !== null;
        if (kind === 'list') pressed = /^\s*-\s+/.test(draft.slice(draft.lastIndexOf('\n', selection.start - 1) + 1));
        return (
          <button
            key={kind}
            type="button"
            aria-label={NOTE_EDITOR[kind]}
            aria-pressed={pressed}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (kind === 'link') {
                setLink({ text: draft.slice(selectionRef.current.start, selectionRef.current.end) });
                return;
              }
              apply({ kind });
            }}
          >
            <Glyph size={20} strokeWidth={2} aria-hidden />
          </button>
        );
      })}
      {phone && <button type="button" className="st-board-note-save" onClick={save}>{NOTE_EDITOR.save}</button>}
    </div>
  );
  return (
    <div ref={box} style={viewportStyle} className={`st-board-note-editor${phone ? ' st-board-note-editor--phone' : ''}`} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.target === writing.current && (event.metaKey || event.ctrlKey)) {
        const key = event.key.toLowerCase();
        if (key === 'a') {
          event.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(writing.current);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          readSelection();
          return;
        }
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          const restored = documentRef.current.undo(key === 'y' || event.shiftKey, selectionRef.current);
          if (restored) redraw(restored);
          return;
        }
      }
      focus(event);
    }}>
      <div className="st-board-note-header">
        {phone && !link && <button type="button" onClick={cancel}>{NOTE_EDITOR.cancel}</button>}
        <div><h3>{NOTE_EDITOR.title}</h3>{phone && <p>{title}</p>}</div>
      </div>
      <div className="st-board-note-box">
        {!phone && toolbar}
        <div
          key={rendered.revision}
          ref={writing}
          role="textbox"
          aria-label={WORKSPACE.note}
          aria-multiline="true"
          contentEditable
          data-note-start={0}
          data-note-end={rendered.text.length}
          tabIndex={0}
          suppressContentEditableWarning
          className="st-board-note-writing"
          onInput={input}
          onSelect={readSelection}
          onKeyUp={readSelection}
          onMouseUp={readSelection}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => {
            composing.current = false;
            redraw(selectionRef.current);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const current = readNote(writing.current).selection;
            const selected = current.source ?? documentRef.current.sourceSelection(current);
            const text = event.clipboardData.getData('text/plain');
            const draft = documentRef.current.text;
            documentRef.current.replace(draft.slice(0, selected.start) + text + draft.slice(selected.end), selected);
            redraw({ start: selected.start + text.length, end: selected.start + text.length });
          }}
          onBeforeInput={(event) => {
            if (!typingFormat || !event.data) return;
            event.preventDefault();
            const current = selectionRef.current;
            const draft = documentRef.current.text;
            const inserted = draft.slice(0, current.start) + event.data + draft.slice(current.end);
            const result = formatNote(inserted, { start: current.start, end: current.start + event.data.length }, { kind: typingFormat });
            documentRef.current.replace(result.text, current);
            setTypingFormat(null);
            redraw({ start: result.selection.end, end: result.selection.end });
          }}
        >{blocks}</div>
        {link ? (
          <LinkEditor title={NOTE_EDITOR.link} text={link.text} onCancel={closeLink} onApply={({ text, url }) => {
            apply({ kind: 'link', text, url });
            setLink(null);
          }} />
        ) : phone && toolbar}
      </div>
      {!phone && (
        <div className="st-board-note-actions">
          <button type="button" className="st-board-step-action st-board-step-action--secondary" onClick={cancel}>{NOTE_EDITOR.cancel}</button>
          <button type="button" className="st-board-step-action st-board-step-action--primary" onClick={save}>{NOTE_EDITOR.save}</button>
        </div>
      )}
      {discarding && createPortal(
        <div ref={discardLayer} style={viewport.style} className={`st-board-composer-layer ${phone ? 'is-phone' : 'is-wide'}`}>
          <DiscardDraft
            phone={phone}
            onKeep={() => setDiscarding(false)}
            onDiscard={() => {
              workspaceEvent('noteDiscard');
              onCancel();
            }}
          />
        </div>,
        document.body,
      )}
    </div>
  );
});

export function readNote(root, range = null) {
  if (!range) {
    const selection = root.ownerDocument?.getSelection();
    if (selection?.rangeCount && root.contains(selection.anchorNode)) range = selection.getRangeAt(0);
  }
  const positions = [];
  const source = [];
  let text = '';
  const selection = { start: 0, end: 0, source: null };
  const attribute = (node, name) => {
    const value = node.getAttribute?.(name);
    return value == null ? null : Number(value);
  };
  const sourceEnd = (node) => {
    const end = attribute(node, 'data-note-end');
    if (end !== null) return end;
    if (node.nodeType === 3) {
      const start = attribute(node.parentNode, 'data-note-text');
      return start === null ? null : start + node.data.length;
    }
    if (node.childNodes.length > 0) return sourceEnd([...node.childNodes].at(-1));
    return null;
  };
  const append = (value, start = null) => {
    text += value;
    for (let index = 0; index < value.length; index += 1) source.push(start === null ? null : start + index);
  };
  const position = (node, offset, sourceOffset = null) => {
    const point = { node, offset, markdown: text.length, source: sourceOffset };
    positions.push(point);
    if (range?.startContainer === node && range.startOffset === offset) {
      selection.start = text.length;
      selection.source = { start: sourceOffset, end: sourceOffset };
    }
    if (range?.endContainer === node && range.endOffset === offset) {
      selection.end = text.length;
      selection.source ??= { start: null, end: null };
      selection.source.end = sourceOffset;
    }
  };
  const block = (node) => ['P', 'DIV', 'UL', 'LI'].includes(node.nodeName);
  const serialize = (node) => {
    if (node.nodeType === 3) {
      const start = attribute(node.parentNode, 'data-note-text');
      for (let offset = 0; offset <= node.data.length; offset += 1) {
        position(node, offset, start === null ? null : start + offset);
        if (offset < node.data.length) append(node.data[offset], start === null ? null : start + offset);
      }
      return;
    }
    const tag = node.nodeName;
    const start = attribute(node, 'data-note-start');
    const end = attribute(node, 'data-note-end');
    let marker = '';
    if (['STRONG', 'B'].includes(tag)) marker = '**';
    if (['EM', 'I'].includes(tag)) marker = '*';
    const url = node.getAttribute?.('href');
    const link = tag === 'A' && SAFE_URL.test(url ?? '') ? url : null;
    if (marker) append(marker, start);
    if (link) append('[', start);
    if (tag === 'LI') append('- ', attribute(node, 'data-note-marker'));
    if (tag === 'BR') {
      const siblings = [...(node.parentNode?.childNodes ?? [])];
      const index = siblings.indexOf(node);
      const filler = node.hasAttribute?.('data-note-placeholder') || siblings.length === 1
        || (index === siblings.length - 1 && siblings[index - 1]?.nodeName === 'BR');
      if (!filler) append('\n', start);
      return;
    }
    const children = [...node.childNodes];
    children.forEach((child, index) => {
      if (index > 0 && (block(child) || block(children[index - 1]))) append('\n', sourceEnd(children[index - 1]));
      position(node, index, index === 0 ? start : sourceEnd(children[index - 1]));
      serialize(child);
    });
    position(node, children.length, end ?? sourceEnd(children.at(-1) ?? node));
    if (marker) append(marker, end === null ? null : end - marker.length);
    if (link) append(`](${link})`, end === null ? null : end - link.length - 3);
  };
  serialize(root);
  if (selection.source?.start === null || selection.source?.end === null) selection.source = null;
  return { text, source, positions, selection };
}
