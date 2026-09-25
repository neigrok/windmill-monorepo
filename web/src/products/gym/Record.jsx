import React, { useState } from 'react';
import { Button, Input } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { gymApi } from './gymApi.js';
import { cappedName, isNameOverCap, nameCountLabel, recordHref, ROUTINES_HREF, showsNameCount } from './log.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { backOf, NEVER_LOGGED, NEVER_LOGGED_LINE, RENAME_PROOF, recordView, renameProofOf } from './record.js';
import { recordProgress } from './progress/progress.js';
import { MovementChart } from './progress/Progress.jsx';
import { useGymRead } from './useGymRead.js';

// `from` is where the record was opened (log.js `recordFromOf`); its back link returns there.
export function MovementRecord({ id, from, log }) {
  if (id == null) return <MovementChooser log={log} />;
  return <OneMovement id={id} from={from} log={log} />;
}

function MovementChooser({ log }) {
  const [query, setQuery] = useState('');
  if (log.phase === 'loading') return <p className="gym-quiet">Opening your movements…</p>;
  return (
    <MovementPicker
      catalog={log.catalog}
      sessions={log.summaries}
      query={query}
      onQuery={setQuery}
      onPick={(exerciseId) => { window.location.hash = recordHref(exerciseId); }}
      onClose={() => { window.location.hash = ROUTINES_HREF; }}
      title="Movements"
    />
  );
}

// Opened from a workout, the session is read beside the record: the back link is named by its
// routine. A session read that fails costs the link its name, never the record.
function OneMovement({ id, from, log }) {
  const view = useGymRead(
    () => Promise.all([gymApi.record(id), from.screen === 'session' ? gymApi.session(from.id).catch(() => null) : null])
      .then(([record, detail]) => (record ? { record, session: detail?.session ?? null } : null)),
    [id, from.screen, from.id],
  );
  const [renaming, setRenaming] = useState(false);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the movement…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <BackTo from={from} />
        <p className="gym-quiet">This movement isn’t in your catalog.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <BackTo from={from} />
        <p className="gym-read-failed">
          The movement didn’t load.
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      </>
    );
  }

  const model = recordView({ ...view.data.record, ...recordProgress(log.progress?.data, id, view.data.record.exercise.equipment) });
  return (
    <section className="gym-record-screen">
      <BackTo from={from} session={view.data.session} />
      <header className="gym-record-head">
        <h1 className="gym-record-name">{model.name}</h1>
        <button type="button" className="gym-record-rename" onClick={() => setRenaming(true)}>Rename</button>
      </header>
      <p className="gym-record-sub">{view.data.record.exercise.equipment ? `${view.data.record.exercise.equipment[0].toUpperCase()}${view.data.record.exercise.equipment.slice(1)} · ` : ''}Movement record</p>
      {model.logged && <MovementChart id={id} log={log} equipment={view.data.record.exercise.equipment} />}

      {!model.logged && (
        <>
          <p className="gym-quiet">{NEVER_LOGGED}</p>
          <p className="gym-quiet">{NEVER_LOGGED_LINE}</p>
        </>
      )}

      <details className="gym-record-more"><summary>More movement facts</summary>
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

      </details>
      {renaming && (
        <RenameSheet
          name={model.name}
          record={view.data.record}
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

function BackTo({ from, session = null }) {
  const back = backOf(from, session);
  return <Back href={back.href}>{back.label}</Back>;
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
        <Input
          value={typed}
          ariaLabel="Movement name"
          onChange={(event) => setTyped(cappedName(event.target.value))}
          autoFocus
          trailing={showsNameCount(typed) && (
            <span className={isNameOverCap(typed) ? 'gym-name-count is-over' : 'gym-name-count'}>
              {nameCountLabel(typed)}
            </span>
          )}
        />
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
        <Button
          full
          disabled={!ready}
          onClick={async () => {
            setSaving(true);
            if (await onSave(typed)) return;
            setSaving(false);
          }}
        >
          Rename
        </Button>
        <button type="button" className="gym-name-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
