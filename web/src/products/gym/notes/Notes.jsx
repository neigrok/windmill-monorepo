import React, { useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { lengthIn } from '../../../platform/sync/core/values.js';
import '../coach/coach.css';
import './notes.css';
import { Back } from '../Back.jsx';

import { COACH_HREF, NOTES_HREF } from '../log.js';
import { CoachNavigation } from '../coach/CoachNavigation.jsx';
import { COACH_TITLE } from '../coach/coach.js';
import { useRail } from '../rail.js';
import { useDomainRead } from '../useDomainRead.js';
import { useGymApi } from '../gymSync.js';
import { Note, NoteRules } from '../domain/notes.js';
import { noteDraft, notesDocument } from '../gymRuntime.js';
import {
  ADD_VERB, byteCountLabel, DELETE_VERB, firstLineOf, FULL_LINE, HEAD_LINE, HONESTY_LINE,
  noteRefusal, NOTES_FAILED, NOTES_TITLE,
  PLACEHOLDER_TITLES, PRECEDENCE_CAPTION, showsByteCount, showsTitleCount,
  titleCountLabel,
} from './notes.js';

function countReadout(label) {
  return label.split(/(\d+)/).map((part, index) => index % 2 ? <span key={index}>{part}</span> : part);
}

// The kit draws visible notes and counts stored ones, including an open delete window.
export function Notes({ log }) {
  const api = useGymApi();
  const view = useDomainRead((read) => ({ notes: notesDocument(read), capacity: read.repository(Note).capacity(),
    firstPullComplete: read.firstPullComplete() }));
  const [editing, setEditing] = useState(null);
  // Keep the rail's selected index aligned until every queued move has published.
  const [order, setOrder] = useState(null);
  const pendingMoves = useRef(0);
  const drawn = view.data?.notes ?? [];
  const notes = order === null ? drawn : [
    ...order.flatMap((id) => drawn.filter((note) => note.id === id)),
    ...drawn.filter((note) => !order.includes(note.id)),
  ];
  const capacity = view.data?.capacity;
  const phase = view.phase === 'ready' && !view.data.firstPullComplete && capacity.used === 0 ? 'loading' : view.phase;

  // The rail names the selected note and its new drawn predecessor; the domain moves that id alone.
  const move = async (from, to) => {
    if (from === to || !notes[from] || !notes[to]) return false;
    const { id } = notes[from];
    const below = (from < to ? notes[to] : notes[to - 1])?.id ?? null;
    const next = notes.map((note) => note.id);
    next.splice(from, 1);
    next.splice(to, 0, id);
    pendingMoves.current += 1;
    setOrder(next);
    try {
      await api.moveNote(id, below);
      return true;
    } catch (error) {
      log.say(noteRefusal(error, 'reordered'));
      return false;
    } finally {
      pendingMoves.current -= 1;
      if (pendingMoves.current === 0) setOrder(null);
    }
  };

  // The durable death is held while Undo is available, and the editor leaves in the same act.
  // Nothing is confirmed — a question in front of an act that can be undone is ceremony
  // (13-gestures.md Law 2).
  const remove = (note) => {
    log.holdDelete({
      kind: 'note',
      id: note.id,
      refused: (error) => log.say(noteRefusal(error, 'deleted')),
    });
    setEditing(null);
  };

  if (editing) {
    return (
      <NoteEditor
        note={editing}
        noteCount={capacity?.used ?? null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
        }}
        onDelete={remove}
        onStale={view.retry}
      />
    );
  }

  const fresh = (title = '') => setEditing({ id: api.mintNote(), title, body: '', fresh: true });

  return (
    <section className="gym-notes">
      <CoachNavigation active="notes" noteCount={capacity?.used ?? null} />
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
      <header className="gym-notes-heading">
        <div className="gym-notes-head">
          <h1 className="gym-title">{NOTES_TITLE}</h1>
          <p className="gym-notes-sub">{HEAD_LINE}</p>
        </div>
        <p className="gym-notes-disclosure">{HONESTY_LINE}</p>
      </header>

      {phase === 'loading' && <p className="gym-quiet">Opening your notes…</p>}
      {phase === 'failed' && (
        <p className="gym-read-failed">
          {NOTES_FAILED}
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      )}

      {phase === 'ready' && (
        <>
          {capacity.used === 0 && (
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

          {notes.length > 0 && <NoteList notes={notes} onOpen={setEditing} onMove={move} />}
          <div className="gym-notes-footer">
            {notes.length > 1 && <p className="gym-notes-caption">{PRECEDENCE_CAPTION}</p>}
            {capacity.isFull
              ? <p className="gym-notes-full">{FULL_LINE}</p>
              : <button type="button" className="gym-notes-add" onClick={() => fresh()}>{ADD_VERB}</button>}
          </div>
        </>
      )}
    </section>
  );
}

// Pointer events, not drag events, which do not fire on touch; rows are one height, so travel is rows crossed.
// The rail is the routine editor's rail (`useRail`): the same drag, the same arrows, the same pick up
// and place down. No focus is followed here — these rows are keyed by `note.id`, so the row a move
// lifts is the same node when it lands.
function NoteList({ notes, onOpen, onMove }) {
  const [drag, setDrag] = useState(null);
  const rowHeight = useRef(0);

  const rail = useRail({
    count: notes.length,
    nameOf: (index) => notes[index].title,
    placeOf: (index) => `${index + 1} of ${notes.length}`,
    move: async (from, to) => { if (!await onMove(from, to)) rail.reset(); },
  });

  const shift = (event) => Math.round((event.clientY - drag.from) / (rowHeight.current || 1));

  return (
    <>
      <ul className="gym-notes-rows">
        {notes.map((note, index) => {
          const meta = firstLineOf(note.body);
          return (
            <li
              className={drag?.index === index ? 'gym-note is-dragging' : 'gym-note'}
              key={note.id}
              style={drag?.index === index ? { transform: `translateY(${drag.by}px)` } : undefined}
            >
              <button
                type="button"
                className="gym-note-rail"
                aria-label={rail.nameFor(index)}
                aria-pressed={rail.picked === index}
                onClick={(event) => rail.activate(index, event)}
                onKeyDown={(event) => rail.keyDown(index, event)}
                onPointerDown={(event) => {
                  rail.grabbed();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  rowHeight.current = event.currentTarget.closest('.gym-note').getBoundingClientRect().height;
                  setDrag({ index, from: event.clientY, by: 0 });
                }}
                onPointerMove={(event) => { if (drag) setDrag({ ...drag, by: event.clientY - drag.from }); }}
                onPointerUp={(event) => {
                  if (!drag) return;
                  const moved = shift(event);
                  setDrag(null);
                  // A drop past the last row travels further than there are rows: it lands on the end.
                  rail.dropped(drag.index, Math.min(Math.max(drag.index + moved, 0), notes.length - 1));
                }}
                onPointerCancel={() => setDrag(null)}
              >
                ⠿
              </button>
              <button type="button" className="gym-note-row" onClick={() => onOpen(note)}>
                <span className="gym-note-summary">
                  <span className="gym-note-title">{note.title}</span>
                  {meta && <span className="gym-note-meta">{meta}</span>}
                </span>
                <span className="gym-note-chevron" aria-hidden="true">›</span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* The move is said here, once, for every path alike, and the line is read rather than drawn:
          the row itself already carries its place, and what the handle would do next, in its name. */}
      <p className="gym-said" role="status">{rail.said}</p>
    </>
  );
}

// Over the bound the store refuses, and its sentence is shown in place; nothing here rewrites it.
// A refusal for a full account (`cap`) means the list behind the editor is behind the store:
// `onStale` re-reads it while the editor stays open with the sentence.
export function NoteEditor({ note, noteCount = null, onClose, onSaved, onDelete, onStale }) {
  const api = useGymApi();
  const [draft, setDraft] = useState(() => noteDraft(note));
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState('');

  const ready = title.trim() !== '' && !saving;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setRefused('');
    try {
      const stored = await api.saveNote(note.id, { title, body }, draft);
      setDraft(stored.draft);
      onSaved(stored);
    } catch (error) {
      setSaving(false);
      setRefused(noteRefusal(error, 'saved'));
      if (error?.code === 'cap') onStale();
    }
  };

  return (
    <section className={`gym-note-editor${note.fresh ? ' is-new' : ''}`}>
      <CoachNavigation active="notes" noteCount={noteCount} />
      <Back href={NOTES_HREF} onClick={(event) => { event.preventDefault(); onClose(); }}>{NOTES_TITLE}</Back>
      <header className="gym-notes-heading">
        <h1 className="gym-title">{note.fresh ? 'New note' : 'Edit note'}</h1>
        <p className="gym-notes-disclosure">{HONESTY_LINE}</p>
      </header>
      <div className="gym-note-fields">
        <div className="gym-note-field">
          <label className="gym-note-label" htmlFor="gym-note-title">Title</label>
          <input
            id="gym-note-title"
            className="gym-note-title-input"
            value={title}
            placeholder="Give this note a title"
            aria-label="Note title"
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          {showsTitleCount(title) && (
            <p className={lengthIn(NoteRules.title.unit, title) > NoteRules.title.max ? 'gym-note-count is-over' : 'gym-note-count'}>{countReadout(titleCountLabel(title))}</p>
          )}
        </div>
        <div className="gym-note-field">
          <label className="gym-note-label" htmlFor="gym-note-body">What Coach should know</label>
          <textarea
            id="gym-note-body"
            className="gym-note-body"
            value={body}
            rows={8}
            placeholder="Write a note for Coach"
            aria-label="Note body"
            onChange={(event) => setBody(event.target.value)}
          />
          {showsByteCount(body) && (
            <p className={lengthIn(NoteRules.body.unit, body) > NoteRules.body.max ? 'gym-note-count is-over' : 'gym-note-count'}>{countReadout(byteCountLabel(body))}</p>
          )}
        </div>
      </div>
      {refused && <p className="gym-editor-missing">{refused}</p>}

      {/* One press. The window holds the delete, the editor is left in the same act, and the room's
          transient is where the way back and the refusal after it are both said. */}
      {!note.fresh && (
        <button type="button" className="gym-note-delete" onClick={() => onDelete(note)}>{DELETE_VERB}</button>
      )}
      <div className="gym-note-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <Button disabled={!ready} ariaBusy={saving} onClick={save}>{saving ? 'Saving…' : 'Save note'}</Button>
      </div>
    </section>
  );
}
