import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../design-system/Icon.jsx';
import { Checklist } from './Checklist.jsx';

// Note dialect: **bold**, *italic*, [text](url), "- " lists. Link hrefs are kept to safe schemes
// so a note can't smuggle in a javascript: URL.
export const SAFE_URL = /^(https?:|mailto:)/i;

export function LinkRow({ url, title, domain, onDelete }) {
  const host = domain || url.replace(/^\w+:\/\//, '').replace(/[/?#].*$/, '');
  return (
    <div className="st-link-row">
      <a className="st-link-open" href={url} target="_blank" rel="noopener noreferrer">
        <span className="st-link-tile">{(host.charAt(0) || '?').toUpperCase()}</span>
        <span className="st-link-main">
          <span className="st-link-title">{title || host}</span>
          <span className="st-link-domain">{host}</span>
        </span>
        <span className="st-link-go"><Icon name="external-link" size={14} /></span>
      </a>
      {onDelete && (
        <button type="button" className="st-link-del" aria-label="Remove link" onClick={onDelete}>
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}

function renderInline(text, key) {
  const nodes = [];
  let rest = text;
  let seq = 0;
  while (rest.length > 0) {
    const link = rest.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    const bold = rest.match(/\*\*([^*]+)\*\*/);
    const italic = rest.match(/\*([^*]+)\*/);
    const candidates = [
      link && { kind: 'link', at: link.index, match: link },
      bold && { kind: 'bold', at: bold.index, match: bold },
      italic && { kind: 'italic', at: italic.index, match: italic },
    ].filter(Boolean);
    if (candidates.length === 0) { nodes.push(rest); break; }

    const next = candidates.reduce((best, one) => (one.at < best.at ? one : best));
    if (next.at > 0) nodes.push(rest.slice(0, next.at));
    const [whole, inner, url] = next.match;
    const k = `${key}-${seq++}`;
    if (next.kind === 'link') {
      nodes.push(
        SAFE_URL.test(url)
          ? <a key={k} href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{inner}</a>
          : inner,
      );
    } else if (next.kind === 'bold') {
      nodes.push(<strong key={k}>{renderInline(inner, k)}</strong>);
    } else {
      nodes.push(<em key={k}>{renderInline(inner, k)}</em>);
    }
    rest = rest.slice(next.at + whole.length);
  }
  return nodes;
}

function renderMarkdown(md) {
  const blocks = [];
  let list = null;
  let para = null;
  const flushPara = () => { if (para) { blocks.push(<p key={`p${blocks.length}`}>{para}</p>); para = null; } };
  const flushList = () => { if (list) { blocks.push(<ul key={`u${blocks.length}`}>{list}</ul>); list = null; } };

  md.split('\n').forEach((line, index) => {
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list) list = [];
      list.push(<li key={index}>{renderInline(bullet[1], `l${index}`)}</li>);
      return;
    }
    if (line.trim() === '') { flushPara(); flushList(); return; }
    flushList();
    if (!para) para = [];
    if (para.length > 0) para.push(<br key={`b${index}`} />);
    para.push(<React.Fragment key={index}>{renderInline(line, `t${index}`)}</React.Fragment>);
  });
  flushPara();
  flushList();
  return blocks;
}

const ADD_CHOICES = [
  { kind: 'subtask', label: 'Sub-task', icon: 'clipboard-check' },
  { kind: 'note', label: 'Note', icon: 'pencil' },
  { kind: 'link', label: 'Link', icon: 'external-link' },
];

export function NodeWorkspace({ nodeId, workspace, hue, onAddSubtask, onToggleSubtask, onEditSubtask, onDeleteSubtask, onSetNote, onAddLink, onDeleteLink }) {
  const subtasks = workspace?.subtasks ?? [];
  const note = workspace?.note ?? '';
  const links = workspace?.links ?? [];

  const [menuOpen, setMenuOpen] = useState(false);
  const [checklistBootstrap, setChecklistBootstrap] = useState(false);
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [linkAdding, setLinkAdding] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const addRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event) => { if (!addRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  const checklistVisible = subtasks.length > 0 || checklistBootstrap;
  const noteVisible = note !== '' || noteEditing;
  const linksVisible = links.length > 0 || linkAdding;

  const missing = ADD_CHOICES.filter((choice) => {
    if (choice.kind === 'subtask') return subtasks.length === 0 && !checklistBootstrap;
    if (choice.kind === 'note') return note === '' && !noteEditing;
    return links.length === 0 && !linkAdding;
  });

  const choose = (kind) => {
    setMenuOpen(false);
    if (kind === 'subtask') setChecklistBootstrap(true);
    if (kind === 'note') { setNoteDraft(''); setNoteEditing(true); }
    if (kind === 'link') setLinkAdding(true);
  };

  const commitNote = () => {
    const markdown = noteDraft.trim();
    setNoteEditing(false);
    if (markdown !== note) onSetNote(nodeId, markdown);
  };

  const commitLink = () => {
    const raw = linkDraft.trim();
    if (raw !== '') onAddLink(nodeId, raw);
    setLinkDraft('');
  };
  const blurLink = () => {
    const raw = linkDraft.trim();
    if (raw !== '') onAddLink(nodeId, raw);
    setLinkDraft('');
    setLinkAdding(false);
  };

  return (
    <>
      {checklistVisible && (
        <Checklist
          items={subtasks}
          hue={hue}
          autoStartAdd={checklistBootstrap}
          onToggle={(id) => onToggleSubtask(nodeId, id)}
          onEdit={(id, label) => onEditSubtask(nodeId, id, label)}
          onDelete={(id) => onDeleteSubtask(nodeId, id)}
          onAdd={(label) => onAddSubtask(nodeId, label)}
          onClose={() => setChecklistBootstrap(false)}
        />
      )}

      {noteVisible && (
        <div>
          <div className="st-step-heading">Note</div>
          {noteEditing ? (
            <textarea
              autoFocus
              className="st-note-edit"
              value={noteDraft}
              placeholder="Write a note…  **bold**, *italic*, [text](url), - lists"
              onChange={(event) => setNoteDraft(event.target.value)}
              onBlur={commitNote}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commitNote(); }
                if (event.key === 'Escape') { event.preventDefault(); setNoteEditing(false); }
              }}
            />
          ) : (
            <div className="st-note-body" onClick={() => { setNoteDraft(note); setNoteEditing(true); }}>
              {renderMarkdown(note)}
            </div>
          )}
        </div>
      )}

      {linksVisible && (
        <div>
          <div className="st-step-heading">Links</div>
          <div className="st-links">
            {links.map((link) => (
              <LinkRow key={link.id} url={link.url} title={link.title} domain={link.domain} onDelete={() => onDeleteLink(nodeId, link.id)} />
            ))}
            <div className="st-link-add">
              <input
                autoFocus={linkAdding}
                className="st-link-input"
                value={linkDraft}
                placeholder="Paste or type a link"
                onChange={(event) => setLinkDraft(event.target.value)}
                onBlur={blurLink}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') { event.preventDefault(); commitLink(); }
                  if (event.key === 'Escape') { event.preventDefault(); setLinkAdding(false); setLinkDraft(''); }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div className="st-ws-add" ref={addRef}>
          <button
            type="button"
            className="st-ws-add-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="plus" size={14} />
            Add to this step
          </button>
          {menuOpen && (
            <div className="st-ws-add-menu" role="menu">
              {missing.map((choice) => (
                <button
                  key={choice.kind}
                  type="button"
                  role="menuitem"
                  className="st-ws-add-item"
                  onClick={() => choose(choice.kind)}
                >
                  <span className="st-ws-add-ico"><Icon name={choice.icon} size={15} /></span>
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
