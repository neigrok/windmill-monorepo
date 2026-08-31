import React, { useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { gymApi } from '../gymApi.js';
import { COACH_HREF, NOTES_HREF } from '../log.js';
import { COACH_TITLE } from '../coach/coach.js';
import { useRail } from '../rail.js';
import { useGymRead } from '../useGymRead.js';
import {
  ADD_VERB, byteCountLabel, DELETE_VERB, firstLineOf, FULL_LINE, HEAD_LINE, HONESTY_LINE,
  isBodyOverCap, isFull, isTitleOverCap, mintNoteId, NOTE_DELETED, noteRefusal, NOTES_FAILED,
  orderOf, PLACEHOLDER_TITLES, PRECEDENCE_CAPTION, reorderNotes, showsByteCount, showsTitleCount,
  titleCountLabel,
} from './notes.js';

// Reached only signed in, like the Coach room it is a door off. The list is the store's order; a
// drag moves it here first and the store's answer replaces it.
export function Notes({ log }) {
  const view = useGymRead(() => gymApi.notes(), []);
  const [held, setHeld] = useState(null);
  const [editing, setEditing] = useState(null);

  // The store's list, and the rows that may be drawn over it: a note the window is holding is off
  // the screen for the length of its window and off it for good once the store has answered — but
  // the store still holds it, which is what BOTH stances about the account are read from: the cap
  // that refuses an eleventh note, and the empty room that offers the first.
  const notes = held ?? view.data ?? [];
  const gone = log.hidden('note');
  const shown = notes.filter((note) => !gone.has(note.id));

  const settle = (list) => {
    setHeld(list);
    view.retry();
  };

  // The indices are the drawn list's; the order sent is the whole store's, which a note held for
  // deletion is still part of until its window closes.
  const move = async (from, to) => {
    const moved = reorderNotes(notes, notes.indexOf(shown[from]), notes.indexOf(shown[to]));
    if (moved === notes) return;
    setHeld(moved);
    try {
      setHeld(await gymApi.reorderNotes(orderOf(moved)));
    } catch (error) {
      log.say(noteRefusal(error, 'reordered'));
      settle(null);
    }
  };

  // Withheld like every other delete in this room: nothing reaches the store for the length of the
  // window, the editor is left in the same act, and the room's transient carries the only way back.
  // Nothing is confirmed — a question in front of an act that can be undone is ceremony
  // (13-gestures.md Law 2).
  const remove = (note) => {
    log.withhold({
      kind: 'note',
      id: note.id,
      line: NOTE_DELETED,
      // In place, never `settle`: the store renumbers the rest, and a reorder sent afterwards must
      // carry the store's own list — but a re-read from `loading` would blank the screen nine
      // seconds after the act, for a row that is already off it.
      send: async () => {
        await gymApi.deleteNote(note.id);
        setHeld(null);
        view.refresh();
      },
      refused: (error) => log.say(noteRefusal(error, 'deleted')),
    });
    setEditing(null);
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
        onDelete={remove}
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
          {/* Off the STORE, like the cap below it: the placeholders seed an account with nothing in
              it, and an account holding one note the window has taken off the screen is not that
              account — the note comes back on Undo, and a placeholder tapped meanwhile mints a
              second. Between them the room draws no rows, which is what both phones draw here. */}
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

          {shown.length > 0 && <NoteList notes={shown} onOpen={open} onMove={move} />}
          {shown.length > 1 && <p className="gym-notes-caption">{PRECEDENCE_CAPTION}</p>}

          {isFull(notes)
            ? <p className="gym-notes-full">{FULL_LINE}</p>
            : <button type="button" className="gym-notes-add" onClick={() => fresh()}>{ADD_VERB}</button>}
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
    move: onMove,
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
                <span className="gym-note-title">{note.title}</span>
                {meta && <span className="gym-note-meta">{meta}</span>}
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
// A refusal for a full account (`notes-full`) means the list behind the editor is behind the store:
// `onStale` re-reads it while the editor stays open with the sentence.
export function NoteEditor({ note, onClose, onSaved, onDelete, onStale }) {
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
      onSaved(await gymApi.saveNote(note.id, { title: title.trim(), body: body.trim() }));
    } catch (error) {
      setSaving(false);
      setRefused(noteRefusal(error, 'saved'));
      if (error?.code === 'notes-full') onStale();
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

      {/* One press. The window holds the delete, the editor is left in the same act, and the room's
          transient is where the way back and the refusal after it are both said. */}
      {!note.fresh && (
        <button type="button" className="gym-note-delete" onClick={() => onDelete(note)}>{DELETE_VERB}</button>
      )}
    </section>
  );
}
