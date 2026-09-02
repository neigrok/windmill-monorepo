import React, { useState } from 'react';
import { Button, DotChart, Tabs } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { gymApi } from '../gymApi.js';
import { BODYWEIGHT_HREF, dayLabel } from '../log.js';
import { weightUnit } from '../units.js';
import { useGymRead } from '../useGymRead.js';
import {
  axisDate, axisValue, BODYWEIGHT_TITLE, chartCaption, chartDomainOf, chartPointsOf, DATE_LABEL,
  dateLocalOf, DEFAULT_WINDOW, DELETE_FAILED, DELETE_VERB, entriesAfter, FAILED,
  fieldValueOf, gapLabel, joinsAcross, latestOf, msOfDateLocal, NO_WEIGH_INS,
  NO_WEIGH_INS_IN_WINDOW, NO_WEIGH_INS_LINE, OPENING, readingLine, SAVE_VERB, saveRefusal,
  WEIGH_IN_DELETED, WEIGH_IN_VERB, weighInWrite, WINDOWS, windowOf,
} from './bodyweight.js';

// The series, read once, with this screen's own writes folded over it until the next read, and
// answered TWICE: `entries` is what the ACCOUNT holds — the read, less the days the store has
// answered a delete for — and `rows` is what the withheld window leaves to draw. A screen's stance
// reads the account and its rows read the window: a window decides which rows are drawn and never
// what state a screen is in (`13-gestures.md`).
//
// What a delete has done is read off the ROOM's two registers and never recorded per instance,
// because the log's head holds a second instance of this hook: a record kept here would leave the
// head drawing a weigh-in the chart has dropped, or the chart calling an account empty that the head
// is reading a number off. A weigh-in's id is its local date — the one id in this room a lifter can
// write again, which takes the delete back and puts the day back in both answers at once.
export function useBodyweight(log) {
  const view = useGymRead(() => gymApi.bodyweight(), []);
  const [moves, setMoves] = useState(() => new Map());
  const gone = log.gone('bodyweight');
  const hidden = log.hidden('bodyweight');
  const entries = entriesAfter(view.data?.entries, moves).filter((entry) => !gone.has(entry.dateLocal));
  const rows = entries.filter((entry) => !hidden.has(entry.dateLocal));

  const save = async (write) => {
    // The id is a local date, so this may be the day a delete is still holding or has already taken.
    // Writing the day again takes that delete back before anything reaches the store: the number the
    // lifter just typed is what stands, and no clock is left to destroy it.
    log.writtenAgain('bodyweight', write.dateLocal);
    try {
      const stored = await gymApi.saveBodyweight(write.dateLocal, write);
      setMoves((current) => new Map(current).set(stored.dateLocal, stored));
      return null;
    } catch (error) {
      return saveRefusal(error);
    }
  };

  // Withheld like every other delete in this room: nothing reaches the store for the length of the
  // window, and the transient carries the only way back. The window abandons what it holds when the
  // room leaves the foreground, so a weigh-in abandoned on backgrounding puts its dot back.
  const remove = (dateLocal) => log.withhold({
    kind: 'bodyweight',
    id: dateLocal,
    line: WEIGH_IN_DELETED,
    send: () => gymApi.deleteBodyweight(dateLocal),
    refused: () => log.say(DELETE_FAILED),
  });

  return {
    phase: view.phase,
    entries,
    rows,
    latest: latestOf(rows),
    retry: () => { setMoves(new Map()); view.retry(); },
    save,
    remove,
  };
}

// The quiet line at the head of the log: the last number and its age, or nothing at all.
export function BodyweightReading({ latest, now = Date.now() }) {
  const line = readingLine(latest, now);
  if (!line) return null;
  return <a className="gym-bodyweight-reading" href={BODYWEIGHT_HREF}>{line}</a>;
}

// The only door onto entering a weigh-in, pinned in the reach band of the log.
export function WeighInChip({ onOpen }) {
  return (
    <div className="gym-reach">
      <button type="button" className="gym-reach-chip" onClick={onOpen}>{WEIGH_IN_VERB}</button>
    </div>
  );
}

// One sheet for entering, correcting and deleting: a plain decimal field in the account's unit, a
// date that defaults to today, reaches no later than today and is fixed when the sheet opens on a dot. `onSave` and `onDelete`
// answer null when the write landed and the refusal to draw when it did not.
export function WeighInSheet({ entry = null, fixedDate = null, onSave, onDelete = null, onClose, now = Date.now() }) {
  const [text, setText] = useState(() => (entry ? fieldValueOf(entry.weightKg) : ''));
  const [date, setDate] = useState(() => fixedDate ?? entry?.dateLocal ?? dateLocalOf(now));
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const write = weighInWrite(text, date, Date.now());
    if (write.refusal) {
      setRefusal(write.refusal);
      return;
    }
    setBusy(true);
    const refused = await onSave(write);
    if (refused) {
      setRefusal(refused);
      setBusy(false);
    }
  };

  return (
    <div className="gym-sheet-catch is-dimmed" role="presentation" onClick={onClose}>
      <div className="gym-sheet gym-weigh" role="dialog" aria-label={WEIGH_IN_VERB} onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-sheet-title">{WEIGH_IN_VERB}</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="gym-weigh-field">
          <input
            className="gym-weigh-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-label={`${BODYWEIGHT_TITLE} in ${weightUnit()}`}
            onChange={(event) => { setText(event.target.value); setRefusal(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
            autoFocus
          />
          <span className="gym-weigh-unit">{weightUnit()}</span>
        </div>

        {fixedDate ? (
          <p className="gym-weigh-date">
            <span className="gym-weigh-date-label">{DATE_LABEL}</span>
            <span className="gym-weigh-date-fixed">{dayLabel(msOfDateLocal(fixedDate))}</span>
          </p>
        ) : (
          <label className="gym-weigh-date">
            <span className="gym-weigh-date-label">{DATE_LABEL}</span>
            <input
              className="gym-weigh-date-input"
              type="date"
              value={date}
              max={dateLocalOf(now)}
              onChange={(event) => { setDate(event.target.value); setRefusal(''); }}
            />
          </label>
        )}

        {refusal && <p className="gym-weigh-refusal">{refusal}</p>}

        <button type="button" className={busy ? 'gym-weigh-save is-inert' : 'gym-weigh-save'} onClick={save} aria-busy={busy}>
          {SAVE_VERB}
        </button>

        {/* One press. The window holds the delete, the sheet closes in the same act, and the room's
            transient — which a sheet would sit over — is where the way back is drawn. */}
        {onDelete && (
          <button type="button" className="gym-weigh-delete" onClick={() => onDelete(fixedDate)}>{DELETE_VERB}</button>
        )}
      </div>
    </div>
  );
}

// The chart: a dot per weigh-in in a stated window, and the repair path behind each dot. No second
// door onto a new weigh-in here; that is the chip on the log, one back away.
export function BodyweightScreen({ log }) {
  const weights = useBodyweight(log);
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW);
  const [fixing, setFixing] = useState(null);
  const now = Date.now();
  const shown = windowOf(weights.rows, windowId, now);
  const entry = fixing ? weights.rows.find((each) => each.dateLocal === fixing) ?? null : null;

  return (
    <section className="gym-bodyweight">
      <Back href="#/gym/log">The log</Back>
      <header className="gym-bodyweight-head">
        <h1 className="gym-title">{BODYWEIGHT_TITLE}</h1>
        <Tabs
          tabs={WINDOWS.map((window) => ({ value: window.id, label: window.label }))}
          value={windowId}
          onChange={setWindowId}
        />
      </header>

      {weights.phase === 'loading' && <p className="gym-quiet">{OPENING}</p>}
      {weights.phase === 'failed' && (
        <p className="gym-read-failed">
          {FAILED}
          <Button variant="secondary" size="sm" onClick={weights.retry}>Retry</Button>
        </p>
      )}

      {/* Off the ACCOUNT: an account holding one weigh-in the window has taken off the chart is not
          an account with no weigh-ins — it comes back on Undo, and the invitation would be drawn
          over a number that is still there. Between the two stances the room draws neither line. */}
      {weights.phase === 'ready' && weights.entries.length === 0 && (
        <>
          <p className="gym-quiet">{NO_WEIGH_INS}</p>
          <p className="gym-quiet">{NO_WEIGH_INS_LINE}</p>
        </>
      )}
      {weights.phase === 'ready' && weights.rows.length > 0 && shown.length === 0 && (
        <p className="gym-quiet">{NO_WEIGH_INS_IN_WINDOW}</p>
      )}

      {shown.length > 0 && (
        <div className="gym-bodyweight-chart">
          <DotChart
            points={chartPointsOf(shown)}
            domain={chartDomainOf(shown, windowId, now)}
            joins={joinsAcross}
            gapLabel={gapLabel}
            formatValue={axisValue}
            formatDate={axisDate}
            caption={chartCaption(windowId, shown.length)}
            ariaLabel={BODYWEIGHT_TITLE}
            onPick={(point) => setFixing(point.dateLocal)}
          />
        </div>
      )}

      {entry && (
        <WeighInSheet
          key={entry.dateLocal}
          entry={entry}
          fixedDate={entry.dateLocal}
          onSave={async (write) => {
            const refused = await weights.save(write);
            if (!refused) setFixing(null);
            return refused;
          }}
          onDelete={(dateLocal) => {
            weights.remove(dateLocal);
            setFixing(null);
          }}
          onClose={() => setFixing(null)}
        />
      )}
    </section>
  );
}
