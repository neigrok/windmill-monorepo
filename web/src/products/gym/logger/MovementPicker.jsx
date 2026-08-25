import React, { useState } from 'react';
import { gymApi } from '../gymApi.js';
import { isNameOverCap, NAME_MAX, nameCountLabel, showsNameCount } from '../log.js';
import { useGymRead } from '../useGymRead.js';
import {
  DEFAULT_EQUIPMENT, EQUIPMENT_CHOICES, lastSetLabel, lastSetsById, movementOptions,
} from './movements.js';

export function MovementPicker({
  catalog, order = [], query, onQuery, onPick, onCreate, onClose, title = 'Movements',
}) {
  const { matches, empty, create } = movementOptions({ catalog, order, query });
  const [minting, setMinting] = useState(null);
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
                {each.custom && <span className="gym-picker-tag">yours</span>}
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
          {showsNameCount(draft.name) && (
            <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>
              {nameCountLabel(draft.name)}
            </span>
          )}
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
