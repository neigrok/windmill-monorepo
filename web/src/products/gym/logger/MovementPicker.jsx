import React, { useRef, useState } from 'react';
import { Button, Icon, Input } from '../../../design-system/index.js';
import { gymApi } from '../gymApi.js';
import { cappedName, isNameOverCap, nameCountLabel, showsNameCount } from '../log.js';
import { useGymRead } from '../useGymRead.js';
import {
  DEFAULT_EQUIPMENT, EQUIPMENT_CHOICES, FEATURED_HEAD, lastSetLabel, lastSetsById, movementOptions,
  TRAINED_WINDOW,
} from './movements.js';

// `sessions` is the log this page already holds: the six the empty query opens on are the movements
// it names most, topped up from the opener list both phones draw, so the section is always six.
//
// The window is read once, at the first read that ANSWERS: a picker opened before the log has
// landed would otherwise keep the generic openers for its whole life, so an empty window is
// re-seeded on every render until one arrives. The moment it holds sessions it is frozen — the log
// behind it keeps moving — the mirror's poll lands a finished session, Older appends a page — and
// the six may not reshuffle under a finger that is already reaching for one of them.
export function MovementPicker({
  catalog, order = [], sessions = [], query, onQuery, onPick, onCreate, onClose, title = 'Movements',
}) {
  const held = useRef([]);
  if (held.current.length === 0) held.current = sessions.slice(0, TRAINED_WINDOW);
  const opened = held.current;
  const { featured, matches, empty, create } = movementOptions({ catalog, order, query, sessions: opened });
  const [minting, setMinting] = useState(null);
  const last = useGymRead(() => gymApi.lastSets(), []);
  const meta = last.phase === 'ready' ? lastSetsById(last.data) : null;
  const row = (each) => (
    <li key={each.id}>
      <button type="button" className="gym-picker-row" onClick={() => onPick(each.id)}>
        <span className="gym-picker-named">
          {each.name}
          {each.custom && <span className="gym-picker-tag">yours</span>}
          {each.alias && <span className="gym-picker-alias">{`was “${each.alias}”`}</span>}
        </span>
        {meta && <span className="gym-picker-meta">{lastSetLabel(meta.get(each.id))}</span>}
      </button>
    </li>
  );

  return (
    <div className="gym-picker" role="dialog" aria-label={title}>
      <div className="gym-picker-head">
        <span className="gym-picker-title">{title}</span>
        <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">
          <Icon name="x" size={15} />
        </button>
      </div>
      <Input
        type="search"
        value={query}
        placeholder={catalog.length > 0 ? `Search ${catalog.length} movements` : 'Search movements'}
        ariaLabel="Search movements"
        onChange={(event) => onQuery(event.target.value)}
        autoFocus
      />
      {featured.length > 0 && (
        <>
          <p className="gym-picker-group">{FEATURED_HEAD}</p>
          <ul className="gym-picker-list">{featured.map(row)}</ul>
        </>
      )}
      {/* The six are a shortcut, never a replacement for browsing: the whole catalogue follows them. */}
      <ul className="gym-picker-list">{matches.map(row)}</ul>
      {empty && <p className="gym-picker-empty">{empty}</p>}
      {create && onCreate && (
        <Button
          full
          variant="secondary"
          onClick={() => setMinting({ name: query.trim(), equipment: DEFAULT_EQUIPMENT })}
        >
          {create}
        </Button>
      )}
      {minting && (
        <NewMovement
          draft={minting}
          onChange={setMinting}
          onCancel={() => setMinting(null)}
          onCreate={async (made) => {
            const exercise = await onCreate(made);
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

function NewMovement({ draft, onChange, onCancel, onCreate }) {
  const [creating, setCreating] = useState(false);
  const ready = draft.name.trim() !== '' && !creating;

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onCancel}>
      <div className="gym-sheet" role="dialog" aria-label="Create a movement" onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">not in the library</span>
          <button type="button" className="gym-sheet-cancel" onClick={onCancel}>Cancel</button>
        </div>

        <Input
          label="Name"
          id="gym-new-movement"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: cappedName(event.target.value) })}
          autoFocus
          trailing={showsNameCount(draft.name) && (
            <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>
              {nameCountLabel(draft.name)}
            </span>
          )}
        />

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

        <Button
          full
          disabled={!ready}
          onClick={async () => {
            setCreating(true);
            if (await onCreate({ name: draft.name.trim(), equipment: draft.equipment })) return;
            setCreating(false);
          }}
        >
          {creating ? 'Creating…' : 'Create and add'}
        </Button>
      </div>
    </div>
  );
}
