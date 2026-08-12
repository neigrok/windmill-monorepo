// THE MOVEMENT PICKER — the one door a movement ever comes through on this surface, for the three
// rooms that need one: the routine editor, the backfill form and the record page with no movement
// named yet (§H's third door). It offers ids and never a typed string, because a name typed twice
// is two movements with no history between them; when the catalog holds nothing by that name it
// offers to MINT one, which is the same rule reached from the other side — the string becomes an
// identity before it becomes a set.
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

import React, { useState } from 'react';
import { movementOptions } from './movements.js';

export function MovementPicker({
  catalog, order = [], query, onQuery, onPick, onCreate, onClose, title = 'Movements',
}) {
  const { matches, empty, create } = movementOptions({ catalog, order, query });
  const [minting, setMinting] = useState(false);

  const mint = async () => {
    if (minting) return;
    setMinting(true);
    const made = await onCreate(query);
    setMinting(false);
    // A create that did not land has already said so in the product's own voice. The picker stays
    // open on the query that failed, so the second attempt is one tap and not a re-typed name.
    if (made) onPick(made.id);
  };

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
              <span>{each.name}</span>
              {each.custom && <span className="gym-picker-tag">yours</span>}
            </button>
          </li>
        ))}
      </ul>
      {empty && <p className="gym-picker-empty">{empty}</p>}
      {create && onCreate && (
        <button type="button" className="gym-picker-create" onClick={mint} disabled={minting}>
          {minting ? 'Creating…' : create}
        </button>
      )}
    </div>
  );
}
