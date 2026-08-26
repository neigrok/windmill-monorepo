import React, { useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { gymApi } from '../gymApi.js';
import { COACH_HREF, NOTES_HREF } from '../log.js';
import { COACH_TITLE } from '../coach/coach.js';
import { useGymRead } from '../useGymRead.js';
import {
  ADD_VERB, byteCountLabel, DELETE_CONFIRM, DELETE_VERB, firstLineOf, FULL_LINE, HEAD_LINE,
  HONESTY_LINE, isBodyOverCap, isFull, isTitleOverCap, mintNoteId, noteRefusal, NOTES_FAILED,
  orderOf, PLACEHOLDER_TITLES, PRECEDENCE_CAPTION, reorderNotes, showsByteCount, showsTitleCount,
  titleCountLabel,
} from './notes.js';

// Reached only signed in, like the Coach room it is a door off. The list is the store's order; a
// drag moves it here first and the store's answer replaces it.
export function Notes({ log }) {
  const view = useGymRead(() => gymApi.notes(), []);
  const [held, setHeld] = useState(null);
  const [editing, setEditing] = useState(null);

  const notes = held ?? view.data ?? [];

  const settle = (list) => {
    setHeld(list);
    view.retry();
  };

  const move = async (from, to) => {
    const moved = reorderNotes(notes, from, to);
    if (moved === notes) return;
    setHeld(moved);
    try {
      setHeld(await gymApi.reorderNotes(orderOf(moved)));
    } catch (error) {
      log.say(noteRefusal(error, 'reordered'));
      settle(null);
    }
  };

  if (editing) {
    return (
      <NoteEditor
        note={editing}
        onClose={() => setEditing(null)}
        onSaved={(stored) => {
          setEditing(null);
          settle(notes.some((each) => each.id === stored.id)
            ? notes.map((each) => (each.id === stored.id ? stored : each))
            : [...notes, stored]);
        }}
        onDeleted={(id) => {
          setEditing(null);
          settle(notes.filter((each) => each.id !== id).map((each, position) => ({ ...each, position })));
        }}
        onStale={() => settle(null)}
      />
    );
  }

  const open = (note) => setEditing(note);
  const fresh = (title = '') => open({ id: mintNoteId(), title, body: '', fresh: true });

  return (
    <section className="gym-notes">
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
      <header className="gym-notes-head">
        <h1 className="gym-title">{HONESTY_LINE}</h1>
        <p className="gym-notes-sub">{HEAD_LINE}</p>
      </header>

      {view.phase === 'loading' && held === null && <p className="gym-quiet">Opening your notes…</p>}
      {view.phase === 'failed' && held === null && (
        <p className="gym-read-failed">
          {NOTES_FAILED}
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      )}

      {(view.phase === 'ready' || held !== null) && (
        <>
          {notes.length === 0 && (
            <ul className="gym-notes-rows">
              {PLACEHOLDER_TITLES.map((title) => (
                <li key={title}>
                  <button type="button" className="gym-note-row is-placeholder" onClick={() => fresh(title)}>
                    <span className="gym-note-title">{title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {notes.length > 0 && <NoteList notes={notes} onOpen={open} onMove={move} />}
          {notes.length > 1 && <p className="gym-notes-caption">{PRECEDENCE_CAPTION}</p>}

          {isFull(notes)
            ? <p className="gym-notes-full">{FULL_LINE}</p>
            : <button type="button" className="gym-notes-add" onClick={() => fresh()}>{ADD_VERB}</button>}
        </>
      )}
    </section>
  );
}

// Pointer events, not drag events, which do not fire on touch; rows are one height, so travel is rows crossed.
function NoteList({ notes, onOpen, onMove }) {
  const [drag, setDrag] = useState(null);
  const rowHeight = useRef(0);

  const shift = (event) => Math.round((event.clientY - drag.from) / (rowHeight.current || 1));

  return (
    <ul className="gym-notes-rows">
      {notes.map((note, index) => {
        const meta = firstLineOf(note.body);
        return (
          <li
            className={drag?.index === index ? 'gym-note is-dragging' : 'gym-note'}
            key={note.id}
            style={drag?.index === index ? { transform: `translateY(${drag.by}px)` } : undefined}
          >
            <span
              className="gym-note-rail"
              aria-hidden="true"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                rowHeight.current = event.currentTarget.closest('.gym-note').getBoundingClientRect().height;
                setDrag({ index, from: event.clientY, by: 0 });
              }}
              onPointerMove={(event) => { if (drag) setDrag({ ...drag, by: event.clientY - drag.from }); }}
              onPointerUp={(event) => {
                if (!drag) return;
                const moved = shift(event);
                setDrag(null);
                if (moved !== 0) onMove(drag.index, drag.index + moved);
              }}
              onPointerCancel={() => setDrag(null)}
            >
              ⠿
            </span>
            <button type="button" className="gym-note-row" onClick={() => onOpen(note)}>
              <span className="gym-note-title">{note.title}</span>
              {meta && <span className="gym-note-meta">{meta}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Over the bound the store refuses, and its sentence is shown in place; nothing here rewrites it.
// A refusal for a full account (`notes-full`) means the list behind the editor is behind the store:
// `onStale` re-reads it while the editor stays open with the sentence.
export function NoteEditor({ note, onClose, onSaved, onDeleted, onStale }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState('');
  const [confirming, setConfirming] = useState(false);

  const ready = title.trim() !== '' && !saving;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setRefused('');
    try {
      onSaved(await gymApi.saveNote(note.id, { title: title.trim(), body: body.trim() }));
    } catch (error) {
      setSaving(false);
      setRefused(noteRefusal(error, 'saved'));
      if (error?.code === 'notes-full') onStale();
    }
  };

  const remove = async () => {
    setSaving(true);
    setRefused('');
    try {
      await gymApi.deleteNote(note.id);
      onDeleted(note.id);
    } catch (error) {
      setSaving(false);
      setConfirming(false);
      setRefused(noteRefusal(error, 'deleted'));
    }
  };

  return (
    <section className="gym-note-editor">
      <header className="gym-editor-head">
        <Back href={NOTES_HREF} onClick={(event) => { event.preventDefault(); onClose(); }}>Notes</Back>
        {/* Tappable at every length: over the bound it refuses in place with the store's own
            sentence, so nothing here is ever silently dead. It says it is busy while the save is in
            the air, because it stays tappable through it. */}
        <Button size="md" variant={ready ? 'primary' : 'secondary'} ariaBusy={saving} onClick={save}>Save</Button>
      </header>

      {/* No maxLength: a sixty-first character is taken and counted, and the store's refusal is shown. */}
      <input
        className="gym-note-title-input"
        value={title}
        placeholder="Title"
        aria-label="Note title"
        onChange={(event) => setTitle(event.target.value)}
        autoFocus
      />
      {showsTitleCount(title) && (
        <p className={isTitleOverCap(title) ? 'gym-note-count is-over' : 'gym-note-count'}>{titleCountLabel(title)}</p>
      )}
      <textarea
        className="gym-note-body"
        value={body}
        rows={8}
        placeholder="What Coach should know"
        aria-label="Note body"
        onChange={(event) => setBody(event.target.value)}
      />
      {showsByteCount(body) && (
        <p className={isBodyOverCap(body) ? 'gym-note-count is-over' : 'gym-note-count'}>{byteCountLabel(body)}</p>
      )}
      {refused && <p className="gym-editor-missing">{refused}</p>}

      {!note.fresh && !confirming && (
        <button type="button" className="gym-note-delete" onClick={() => setConfirming(true)}>{DELETE_VERB}</button>
      )}
      {confirming && (
        <section className="gym-confirm">
          <p className="gym-confirm-title">{DELETE_CONFIRM.title}</p>
          <div className="gym-finish-foot">
            <button type="button" className="gym-confirm-keep" onClick={() => setConfirming(false)}>{DELETE_CONFIRM.keep}</button>
            <button type="button" className="gym-confirm-do" onClick={remove} aria-busy={saving}>{DELETE_CONFIRM.confirm}</button>
          </div>
        </section>
      )}
    </section>
  );
}
