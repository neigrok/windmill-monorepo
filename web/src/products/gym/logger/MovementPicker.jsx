// THE MOVEMENT PICKER — the one door a movement ever comes through on this surface, for the three
// rooms that need one: the routine editor, the backfill form and the record page with no movement
// named yet (§H's third door). It offers ids and never a typed string, because a name typed twice
// is two movements with no history between them; when the catalog holds nothing by that name — under
// the name it has now OR any this account used to call it — it offers to MINT one, which is the same
// rule reached from the other side: the string becomes an identity before it becomes a set.
//
// MINTING ONE IS TWO QUESTIONS AND NOT A BUTTON (§N screen 31). What you call it, and how it is
// loaded — the second because it decides what the ladder does at the rack, which
// this surface was quietly answering `barbell` to on every movement anybody ever created here.
//
// WHAT A PICK MEANS IS THE HOST'S TO DECIDE, and the three of them mean different things: two add a
// movement to work in hand, the third navigates to that movement's page. So `onPick` arrives as a
// prop and is never decided in here — a tap that navigated out of a form holding unsaved sets would
// destroy them. `onCreate` is the same rule: the record page does not pass one, so the mint door
// never opens on a page that only reads.
//
// `order` is what this list already holds. No web caller passes it since capture moved to the
// phones (§11) — a routine may legitimately name the same lift twice, and a past workout may hold
// two blocks of it — but which silence a search lands in, and whether it has a door, stays
// movements.js's to decide, never this component's.
//
// AND IT BRINGS ITS OWN META (§B7). The last set of every movement is one read, and this component
// is the one surface on the desk that draws it — so it is asked for here rather than by each of the
// three hosts, and it opens and closes with the picker they mount.

import React, { useState } from 'react';
import { gymApi } from '../gymApi.js';
import { isNameOverCap, NAME_MAX, nameCountLabel } from '../log.js';
import { useGymRead } from '../useGymRead.js';
import {
  DEFAULT_EQUIPMENT, EQUIPMENT_CHOICES, lastSetLabel, lastSetsById, movementOptions,
} from './movements.js';

export function MovementPicker({
  catalog, order = [], query, onQuery, onPick, onCreate, onClose, title = 'Movements',
}) {
  const { matches, empty, create } = movementOptions({ catalog, order, query });
  // THE CREATE DOOR IS THE TWO QUESTIONS AND NOT A SECOND DOOR BESIDE THEM (§N screen 31). The
  // button below opens this and nothing mints until `Create and add` — so the name typed into the
  // search box is an OPENING VALUE for the field rather than the movement's name already decided.
  const [minting, setMinting] = useState(null);
  // READ WHEN THE PICKER OPENS, AND NEVER AGAIN WHILE IT IS UP. The deps are empty deliberately:
  // typing filters the list already in hand, and hanging this off `query` would fire a request per
  // keystroke to redraw rows that are already on screen.
  //
  // A read that has not answered — or never does — leaves the rows with NO meta at all rather than
  // the absence sentence under every one of them, which would be the app answering a question about
  // a lifter's training on the strength of bytes it does not have (gymApi.js).
  const last = useGymRead(() => gymApi.lastSets(), []);
  const meta = last.phase === 'ready' ? lastSetsById(last.data) : null;

  return (
    <div className="gym-picker" role="dialog" aria-label={title}>
      <div className="gym-picker-head">
        <span className="gym-picker-title">{title}</span>
        <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <input
        className="gym-picker-search"
        type="search"
        value={query}
        placeholder={catalog.length > 0 ? `Search ${catalog.length} movements` : 'Search movements'}
        aria-label="Search movements"
        onChange={(event) => onQuery(event.target.value)}
        autoFocus
      />
      <ul className="gym-picker-list">
        {matches.map((each) => (
          <li key={each.id}>
            <button type="button" className="gym-picker-row" onClick={() => onPick(each.id)}>
              <span className="gym-picker-named">
                {each.name}
                {/* SCREEN 7's WORD, which is not screen 30's. This row says `yours` and a routine's
                    row says `· mine` for the same `custom` flag, because that is what the two boards
                    draw and what the phones draw beside them; one of the two wants to become canon,
                    and until it does the surfaces agree with each other rather than with themselves. */}
                {each.custom && <span className="gym-picker-tag">yours</span>}
                {/* WHY THIS ROW IS HERE, and only when that is not obvious: the movement matched on
                    a name this account used to call it, so the row says which one rather than
                    appearing to be an unrelated hit. A movement matched on its own name draws
                    nothing — an alias under every row would be a second name to read on the one
                    screen whose whole job is picking one. */}
                {each.alias && <span className="gym-picker-alias">{`was “${each.alias}”`}</span>}
              </span>
              {meta && <span className="gym-picker-meta">{lastSetLabel(meta.get(each.id))}</span>}
            </button>
          </li>
        ))}
      </ul>
      {empty && <p className="gym-picker-empty">{empty}</p>}
      {create && onCreate && (
        <button
          type="button"
          className="gym-picker-create"
          onClick={() => setMinting({ name: query.trim(), equipment: DEFAULT_EQUIPMENT })}
        >
          {create}
        </button>
      )}
      {minting && (
        <NewMovement
          draft={minting}
          onChange={setMinting}
          onCancel={() => setMinting(null)}
          onCreate={async (made) => {
            const exercise = await onCreate(made);
            // A create that did not land has already said so in the product's own voice. The sheet
            // stays open on what was typed, so the second attempt is one tap and not a re-typed name.
            if (!exercise) return false;
            setMinting(null);
            onPick(exercise.id);
            return true;
          }}
        />
      )}
    </div>
  );
}

// SCREEN 31 — a movement that is not in our sixty-two, in exactly two questions. There is no
// approval, no moderation and no interrogation about whether this is really Bench Press; the only
// rule on the name is its length, because we do not correct anyone's spelling of their own gym.
//
// How it is loaded is the question that earns its place: it is what the ladder reads at the rack. Before this sheet every movement a lifter minted was stored as a barbell.
function NewMovement({ draft, onChange, onCancel, onCreate }) {
  const [creating, setCreating] = useState(false);
  const ready = draft.name.trim() !== '' && !creating;

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onCancel}>
      <div className="gym-sheet" role="dialog" aria-label="Create a movement" onClick={(event) => event.stopPropagation()}>
        {/* THE WORD RATHER THAN THE GLYPH, where screen 31 draws it: this sheet is a form with a
            commit on it, and the way out of a form is named. It is the sheet's one aimed exit — the
            picker's own × is behind it and belongs to the picker. */}
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">not in the library</span>
          <button type="button" className="gym-sheet-cancel" onClick={onCancel}>Cancel</button>
        </div>

        <label className="gym-name-label" htmlFor="gym-new-movement">Name</label>
        <div className="gym-name-field">
          <input
            id="gym-new-movement"
            className="gym-name-input"
            value={draft.name}
            maxLength={NAME_MAX}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            autoFocus
          />
          <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>
            {nameCountLabel(draft.name)}
          </span>
        </div>

        <p className="gym-name-label">How is it loaded?</p>
        <div className="gym-equipment">
          {EQUIPMENT_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              className={draft.equipment === choice ? 'gym-equipment-choice is-on' : 'gym-equipment-choice'}
              onClick={() => onChange({ ...draft, equipment: choice })}
            >
              {choice}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={ready ? 'gym-name-save' : 'gym-name-save is-inert'}
          onClick={async () => {
            if (!ready) return;
            setCreating(true);
            // A create that landed takes this sheet off the screen with it, so the flag is released
            // only on the path where the sheet is still standing.
            if (await onCreate({ name: draft.name.trim(), equipment: draft.equipment })) return;
            setCreating(false);
          }}
        >
          {creating ? 'Creating…' : 'Create and add'}
        </button>
      </div>
    </div>
  );
}
