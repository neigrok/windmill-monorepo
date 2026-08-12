// A MOVEMENT'S RECORD (§H) — one exercise, one page, reached by tapping its name anywhere it
// appears: in a session, in a routine, in the picker. Best e1RM, the trend, every record with its
// date, then the recent sets. This is the page that makes stable exercise identity visible, which is
// what `Rename` is doing at the top of it: the name changes and the history stays whole, because the
// id under it never moves.
//
// IT IS NOT A DASHBOARD, and the room it replaced was on its way to being one. No volume by muscle
// group, no fatigue score, no percentile against strangers, and no weekly bars — those went with the
// statistics tab (§H: *there is no dashboard in this product*). One movement, one number, one arc.
//
// Every number here comes off one read and none of them is computed on this surface (record.js says
// which, and what is deliberately absent where Epley has no answer). What this file is, is the
// drawing.

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from './gymApi.js';
import { recordHref } from './log.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { NEVER_LOGGED, NEVER_LOGGED_LINE, recordView } from './record.js';
import { useGymRead } from './useGymRead.js';

// The wire refuses a name over eighty bytes. This counts UTF-16 units, so a name of eighty emoji is
// still refused by the store — and says so in the product's own voice rather than being silently
// trimmed to something the lifter did not type.
const NAME_MAX = 80;

// Back to Today rather than back to wherever this was opened from. §H's three doors are a session,
// a routine and the picker, and the browser's own Back is what returns to the one you came through;
// a link drawn in the app has to say where it goes, and it can only honestly name a fixed room —
// Today, which is the room a lifter can get anywhere from (§B).
const BACK = '#/gym';

export function MovementRecord({ id, log }) {
  if (id == null) return <MovementChooser log={log} />;
  return <OneMovement id={id} log={log} />;
}

// THE PICKER, AS A ROOM — §H's third door, and the one place a pick may mean "show me this one".
// Inside the routine editor and the backfill form the same component adds a movement to work in
// hand, and a tap that navigated away from either would throw that work away; the meaning of a pick
// belongs to the host, which is why it arrives as a prop and is not decided in there.
//
// It mints nothing: `onCreate` is deliberately not passed, so the create door never opens here. A
// movement created from a page that only reads would be a write nobody asked for.
function MovementChooser({ log }) {
  const [query, setQuery] = useState('');
  // The catalog is the shared read's, and until it answers the picker's own empty state would
  // report a failure that has not happened — the one silence movements.js reserves for a catalog
  // that did not load. A read still in flight says so instead.
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
          onClose={() => setRenaming(false)}
          onSave={async (typed) => {
            const renamed = await log.renameMovement(id, typed);
            if (!renamed) return false;
            setRenaming(false);
            // Re-read rather than patch the model in place: the page is one read, and a name held
            // beside it would be a second source for the one fact this page exists to prove.
            view.retry();
            return true;
          }}
        />
      )}
    </section>
  );
}

// e1RM PER SESSION, AS BARS. The scale runs from zero, because a bar's length IS its value — and the
// bars carry no text, so each one says its own session in words for a reader who is listening
// (record.js). No hover, no tooltip and no scrub: this is read on a phone at a rack.
//
// At most one bar is gold, and it is the session the tile above prints — so the loudest number on
// the page and the tallest bar under it are the same fact seen twice, never two claims a reader has
// to reconcile. Nothing else on this chart is coloured.
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

// ONE FIELD, AND THE ID UNDER IT NEVER MOVES. Renaming Back Squat renames it for this account and
// leaves every set, routine entry and frozen plan snapshot pointing at the same movement — which is
// the promise this whole page exists to make visible, so the sheet says it in a line.
function RenameSheet({ name, onClose, onSave }) {
  const [typed, setTyped] = useState(name);
  const [saving, setSaving] = useState(false);
  const ready = typed.trim() !== '' && !saving;

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
      <div className="gym-sheet" role="dialog" aria-label="Rename movement" onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">Rename</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <input
          className="gym-rename-input"
          value={typed}
          maxLength={NAME_MAX}
          aria-label="Movement name"
          onChange={(event) => setTyped(event.target.value)}
          autoFocus
        />
        <p className="gym-rename-line">The history stays with the movement. Nothing you have logged moves.</p>
        <button
          type="button"
          className={ready ? 'gym-rename-save' : 'gym-rename-save is-inert'}
          onClick={async () => {
            if (!ready) return;
            setSaving(true);
            // A save that landed takes this sheet off the screen with it, so the flag is released
            // only on the path where the sheet is still standing — and the refusal has already been
            // said in the product's one voice (useTrainingLog).
            if (await onSave(typed)) return;
            setSaving(false);
          }}
        >
          Save the name
        </button>
      </div>
    </div>
  );
}
