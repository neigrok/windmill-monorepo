import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from './gymApi.js';
import { isNameOverCap, NAME_MAX, nameCountLabel, recordHref } from './log.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { NEVER_LOGGED, NEVER_LOGGED_LINE, RENAME_PROOF, recordView, renameProofOf } from './record.js';
import { useGymRead } from './useGymRead.js';

const BACK = '#/gym';

export function MovementRecord({ id, log }) {
  if (id == null) return <MovementChooser log={log} />;
  return <OneMovement id={id} log={log} />;
}

function MovementChooser({ log }) {
  const [query, setQuery] = useState('');
  if (log.phase === 'loading') return <p className="gym-quiet">Opening your movements…</p>;
  return (
    <MovementPicker
      catalog={log.catalog}
      query={query}
      onQuery={setQuery}
      onPick={(exerciseId) => { window.location.hash = recordHref(exerciseId); }}
      onClose={() => { window.location.hash = BACK; }}
      title="Movements"
    />
  );
}

function OneMovement({ id, log }) {
  const view = useGymRead(() => gymApi.record(id), [id]);
  const [renaming, setRenaming] = useState(false);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the movement…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <a className="gym-back" href={BACK}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today</a>
        <p className="gym-quiet">This movement isn’t in your catalog.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href={BACK}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today</a>
        <p className="gym-read-failed">
          The movement didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  const model = recordView(view.data);
  return (
    <section className="gym-record-screen">
      <header className="gym-record-head">
        <a className="gym-back" href={BACK}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today</a>
        <button type="button" className="gym-record-rename" onClick={() => setRenaming(true)}>Rename</button>
      </header>
      <h1 className="gym-record-name">{model.name}</h1>
      <p className="gym-record-sub">{model.subhead}</p>

      {!model.logged && (
        <>
          <p className="gym-quiet">{NEVER_LOGGED}</p>
          <p className="gym-quiet">{NEVER_LOGGED_LINE}</p>
        </>
      )}

      {model.tiles.length > 0 && (
        <ul className="gym-record-tiles">
          {model.tiles.map((tile) => (
            <li className={tile.standing ? 'gym-record-tile is-standing' : 'gym-record-tile'} key={tile.label}>
              <span className="gym-record-tile-label">{tile.label}</span>
              <span className="gym-record-tile-value">{tile.value}</span>
              <span className="gym-record-tile-sub">{tile.sub}</span>
            </li>
          ))}
        </ul>
      )}

      {model.chart && <Chart chart={model.chart} />}

      {model.records.length > 0 && (
        <section className="gym-record-block">
          <h2 className="gym-record-block-title">Personal records</h2>
          <ul className="gym-record-marks">
            {model.records.map((mark, index) => (
              <li
                className={mark.standing ? 'gym-record-mark is-standing' : 'gym-record-mark'}
                key={`${mark.at}-${index}`}
              >
                <span className="gym-record-mark-load">{mark.load}</span>
                <span className="gym-record-mark-e1rm">{mark.e1rm}</span>
                <span className="gym-record-mark-when">{mark.when}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {model.days.length > 0 && (
        <section className="gym-record-block">
          <h2 className="gym-record-block-title">Recent sets</h2>
          <ul className="gym-record-days">
            {model.days.map((day) => (
              <li className="gym-record-day" key={day.sessionId}>
                <span className="gym-record-day-when">{day.when}</span>
                <span className="gym-record-day-sets">{day.sets}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {renaming && (
        <RenameSheet
          name={model.name}
          record={view.data}
          onClose={() => setRenaming(false)}
          onSave={async (typed) => {
            const renamed = await log.renameMovement(id, typed);
            if (!renamed) return false;
            setRenaming(false);
            view.retry();
            return true;
          }}
        />
      )}
    </section>
  );
}

function Chart({ chart }) {
  return (
    <figure className="gym-record-chart">
      <figcaption className="gym-record-chart-head">
        <span>e1RM per session</span>
        <span className="gym-record-chart-window">12 weeks</span>
      </figcaption>
      <div className="gym-record-bars" role="list">
        {chart.bars.map((bar, index) => (
          <div
            className={bar.standing ? 'gym-record-bar is-standing' : 'gym-record-bar'}
            key={`${bar.at}-${index}`}
            role="listitem"
            aria-label={bar.label}
          >
            <span className="gym-record-bar-fill" style={{ height: `${bar.pct}%` }} />
          </div>
        ))}
      </div>
      <p className="gym-record-span">
        <span>{chart.from}</span>
        <span>{chart.to}</span>
      </p>
    </figure>
  );
}

function RenameSheet({ name, record, onClose, onSave }) {
  const [typed, setTyped] = useState(name);
  const [saving, setSaving] = useState(false);
  const ready = typed.trim() !== '' && !saving;
  const proof = renameProofOf(record);

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
      <div className="gym-sheet" role="dialog" aria-label="Rename movement" onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">Rename this movement</span>
        </div>
        <div className="gym-name-field">
          <input
            className="gym-name-input"
            value={typed}
            maxLength={NAME_MAX}
            aria-label="Movement name"
            onChange={(event) => setTyped(event.target.value)}
            autoFocus
          />
          <span className={isNameOverCap(typed) ? 'gym-name-count is-over' : 'gym-name-count'}>
            {nameCountLabel(typed)}
          </span>
        </div>
        <section className="gym-follows">
          <p className="gym-follows-head">
            <span className="gym-follows-tick" aria-hidden="true">✓</span>
            {RENAME_PROOF}
          </p>
          <ul className="gym-follows-rows">
            {proof.map((row) => (
              <li className="gym-follows-row" key={row.label}>
                <span className="gym-follows-label">{row.label}</span>
                <span className="gym-follows-value">{row.value}</span>
              </li>
            ))}
          </ul>
        </section>
        <button
          type="button"
          className={ready ? 'gym-name-save' : 'gym-name-save is-inert'}
          onClick={async () => {
            if (!ready) return;
            setSaving(true);
            if (await onSave(typed)) return;
            setSaving(false);
          }}
        >
          Rename
        </button>
        <button type="button" className="gym-name-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
