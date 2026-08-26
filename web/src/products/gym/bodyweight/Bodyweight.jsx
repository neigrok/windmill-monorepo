import React, { useState } from 'react';
import { Button, DotChart, Tabs } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { gymApi } from '../gymApi.js';
import { BODYWEIGHT_HREF, dayLabel } from '../log.js';
import { weightUnit } from '../units.js';
import { useGymRead } from '../useGymRead.js';
import {
  axisDate, axisValue, BODYWEIGHT_TITLE, chartCaption, chartDomainOf, chartPointsOf, DATE_LABEL,
  dateLocalOf, DECIMAL_HINT, DEFAULT_WINDOW, DELETE_CONFIRM, DELETE_FAILED, DELETE_VERB, entriesAfter,
  FAILED, fieldValueOf, GAP_RULE, gapLabel, joinsAcross, latestOf, msOfDateLocal, NO_WEIGH_INS,
  NO_WEIGH_INS_IN_WINDOW, NO_WEIGH_INS_LINE, OPENING, readingLine, SAVE_VERB, saveRefusal, WEIGH_IN_VERB,
  weighInWrite, WINDOWS, windowOf,
} from './bodyweight.js';

// The series, read once, with this screen's own writes folded over it until the next read.
export function useBodyweight() {
  const view = useGymRead(() => gymApi.bodyweight(), []);
  const [moves, setMoves] = useState(() => new Map());
  const entries = entriesAfter(view.data?.entries, moves);

  const save = async (write) => {
    try {
      const stored = await gymApi.saveBodyweight(write.dateLocal, write);
      setMoves((current) => new Map(current).set(stored.dateLocal, stored));
      return null;
    } catch (error) {
      return saveRefusal(error);
    }
  };

  const remove = async (dateLocal) => {
    try {
      await gymApi.deleteBodyweight(dateLocal);
      setMoves((current) => new Map(current).set(dateLocal, null));
      return null;
    } catch {
      return DELETE_FAILED;
    }
  };

  return {
    phase: view.phase,
    entries,
    latest: latestOf(entries),
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
  const [confirming, setConfirming] = useState(false);

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

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    const refused = await onDelete(fixedDate);
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
        <p className="gym-weigh-hint">{DECIMAL_HINT}</p>

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

        {!confirming && (
          <button type="button" className={busy ? 'gym-weigh-save is-inert' : 'gym-weigh-save'} onClick={save} aria-busy={busy}>
            {SAVE_VERB}
          </button>
        )}

        {onDelete && !confirming && (
          <button type="button" className="gym-weigh-delete" onClick={() => setConfirming(true)}>{DELETE_VERB}</button>
        )}
        {onDelete && confirming && (
          <section className="gym-confirm">
            <p className="gym-confirm-title">{DELETE_CONFIRM.title}</p>
            <div className="gym-finish-foot">
              <button type="button" className="gym-confirm-keep" onClick={() => setConfirming(false)}>{DELETE_CONFIRM.keep}</button>
              <button type="button" className={busy ? 'gym-confirm-do is-inert' : 'gym-confirm-do'} onClick={remove} aria-busy={busy}>{DELETE_CONFIRM.confirm}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// The chart: a dot per weigh-in in a stated window, and the repair path behind each dot. No second
// door onto a new weigh-in here; that is the chip on the log, one back away.
export function BodyweightScreen() {
  const weights = useBodyweight();
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW);
  const [fixing, setFixing] = useState(null);
  const now = Date.now();
  const shown = windowOf(weights.entries, windowId, now);
  const entry = fixing ? weights.entries.find((each) => each.dateLocal === fixing) ?? null : null;

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

      {weights.phase === 'ready' && weights.entries.length === 0 && (
        <>
          <p className="gym-quiet">{NO_WEIGH_INS}</p>
          <p className="gym-quiet">{NO_WEIGH_INS_LINE}</p>
        </>
      )}
      {weights.phase === 'ready' && weights.entries.length > 0 && shown.length === 0 && (
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
            rule={GAP_RULE}
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
          onDelete={async (dateLocal) => {
            const refused = await weights.remove(dateLocal);
            if (!refused) setFixing(null);
            return refused;
          }}
          onClose={() => setFixing(null)}
        />
      )}
    </section>
  );
}
