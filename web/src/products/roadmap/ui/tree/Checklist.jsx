// A click anywhere on a row toggles it, a double-click on the text edits it. In the add-run,
// Enter commits and opens the next empty row; Esc or an empty Enter closes it.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../design-system/Icon.jsx';

export function Checklist({ items, hue, autoStartAdd = false, onToggle, onEdit, onDelete, onAdd, onClose }) {
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [adding, setAdding] = useState(autoStartAdd);
  const [addDraft, setAddDraft] = useState('');
  const clickTimer = useRef(null);
  const editRef = useRef(null);

  useEffect(() => {
    if (editingId === null) return;
    editRef.current?.focus();
    editRef.current?.select();
  }, [editingId]);

  const done = items.filter((item) => item.done).length;
  const chkVars = { '--chk-base': hue.base, '--chk-ring': hue.ring };

  // Single/double grammar: a lone click schedules the toggle; a double-click on the text cancels
  // that pending toggle and drops into an edit caret instead.
  const scheduleToggle = (id) => {
    if (clickTimer.current) return;
    clickTimer.current = setTimeout(() => { clickTimer.current = null; onToggle(id); }, 200);
  };
  const beginEdit = (item) => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setAdding(false);
    setEditingId(item.id);
    setEditDraft(item.label);
  };
  const commitEdit = () => {
    const id = editingId;
    const label = editDraft.trim();
    const item = items.find((candidate) => candidate.id === id);
    setEditingId(null);
    if (label !== '' && item && label !== item.label) onEdit(id, label);
  };

  const beginAdd = () => { setEditingId(null); setAdding(true); setAddDraft(''); };
  const endAdd = () => { setAdding(false); setAddDraft(''); onClose?.(); };
  const commitAdd = () => {
    const label = addDraft.trim();
    if (label === '') { endAdd(); return; }
    onAdd(label);
    setAddDraft('');
  };
  const blurAdd = () => {
    const label = addDraft.trim();
    if (label !== '') onAdd(label);
    endAdd();
  };

  return (
    <div>
      <div className="st-check-head">
        <span className="st-step-heading">Checklist</span>
        <span className="st-check-count">{done} of {items.length}</span>
      </div>
      <div className="st-check-list" style={chkVars}>
        {items.map((item) => {
          const editing = editingId === item.id;
          return (
            <div
              key={item.id}
              className="st-check-row"
              onClick={editing ? undefined : () => scheduleToggle(item.id)}
            >
              <span className={`st-check-box ${item.done ? 'st-check-box--done' : ''}`}>
                {item.done && <Icon name="check" size={12} color="#fff" />}
              </span>
              {editing ? (
                <input
                  ref={editRef}
                  className="st-check-input"
                  value={editDraft}
                  onChange={(event) => setEditDraft(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') { event.preventDefault(); commitEdit(); }
                    if (event.key === 'Escape') { event.preventDefault(); setEditingId(null); }
                  }}
                />
              ) : (
                <>
                  <span
                    className={`st-check-label ${item.done ? 'st-check-label--done' : ''}`}
                    onDoubleClick={() => beginEdit(item)}
                  >
                    {item.label}
                  </span>
                  <button
                    type="button"
                    className="st-check-del"
                    aria-label="Delete sub-task"
                    onClick={(event) => { event.stopPropagation(); onDelete(item.id); }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </>
              )}
            </div>
          );
        })}

        {adding ? (
          <div className="st-check-row">
            <span className="st-check-box" />
            <input
              autoFocus
              className="st-check-input"
              value={addDraft}
              placeholder="Sub-task"
              onChange={(event) => setAddDraft(event.target.value)}
              onBlur={blurAdd}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
                if (event.key === 'Escape') { event.preventDefault(); endAdd(); }
              }}
            />
          </div>
        ) : (
          <button type="button" className="st-check-add" onClick={beginAdd}>
            <Icon name="plus" size={13} />
            Add a sub-task
          </button>
        )}
      </div>
    </div>
  );
}
