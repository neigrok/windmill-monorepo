import React, { useState } from 'react';
import { Button, DotChart, Tabs } from '../../../design-system/index.js';
import { Reader, Views } from '../../../platform/domain-kit/reading.js';
import { Back } from '../Back.jsx';

import { BODYWEIGHT_HREF, dayLabel } from '../log.js';
import { weightUnit } from '../units.js';
import { useDomainRead } from '../useDomainRead.js';
import { Bodyweight } from '../domain/bodyweight.js';
import { bodyweightDocument, gymMoment, gymStep, preferencesDocument, weighInInput, weighInKilograms, useGymApi } from '../gymRuntime.js';
import {
  axisDate, axisValue, BODYWEIGHT_TITLE, chartCaption, chartDomainOf, chartPointsOf, DATE_LABEL,
  DEFAULT_WINDOW, deleteRefusal, DELETE_VERB, FAILED,
  fieldValueOf, gapLabel, msOfDateLocal, NO_WEIGH_INS,
  NO_WEIGH_INS_IN_WINDOW, NO_WEIGH_INS_LINE, OPENING, readingLine, SAVE_VERB, saveRefusal,
  WEIGH_IN_VERB, WINDOWS,
} from './bodyweight.js';

export function useBodyweight(log) {
  const api = useGymApi();
  const hidden = log.hidden('bodyweight');
  const view = useDomainRead((read) => {
    // The room hides a requested delete before storage can publish the engine's held view.
    if (hidden.size > 0) read = new Reader(new Views(read.registry, { ...read.views,
      drawn: new Map([...read.views.drawn].filter(([, row]) => row.t !== 'weighin' || !hidden.has(row.id))),
    }), read.scope, read.moment);
    const weights = new Bodyweight(read);
    return { weights, unit: preferencesDocument(read).units, ...bodyweightDocument(read, {}, weights) };
  }, [JSON.stringify([...hidden].sort())]);
  const save = async (write) => {
    try { await api.saveBodyweight(write.dateLocal, write); return null; }
    catch (error) { return saveRefusal(error); }
  };
  const remove = (dateLocal) => log.holdDelete({
    kind: 'bodyweight', id: dateLocal, refused: (error) => log.say(deleteRefusal(error)),
  });
  return { phase: view.data?.weights.stance === 'unknown' ? 'loading' : view.phase,
    weights: view.data?.weights, unit: view.data?.unit ?? 'kg', rows: view.data?.entries ?? [], latest: view.data?.latest ?? null,
    retry: view.retry, save, remove };
}

// The latest recorded weight and its age, shown in the log options.
export function BodyweightReading({ latest, now = Date.now(), unit = weightUnit() }) {
  const line = readingLine(latest, now, unit);
  if (!line) return null;
  return <a className="gym-bodyweight-reading" href={BODYWEIGHT_HREF}>{line}</a>;
}

// One sheet for entering, correcting and deleting: a plain decimal field in the account's unit, a
// date that defaults to today, reaches no later than today and is fixed when the sheet opens on a dot. `onSave` and `onDelete`
// answer null when the write landed and the refusal to draw when it did not.
export function WeighInSheet({ entry = null, fixedDate = null, onSave, onDelete = null, onClose, now = Date.now(), unit = weightUnit() }) {
  const [field, setField] = useState(() => ({ text: entry ? fieldValueOf(entry.weightKg, unit) : '', unit }));
  const parsed = weighInKilograms(field.text, field.unit);
  const text = field.unit === unit || parsed.refusal ? field.text : fieldValueOf(parsed.weightKg, unit);
  const [date, setDate] = useState(() => fixedDate ?? entry?.dateLocal ?? gymMoment(now).today.text);
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    // A setting change only respells the input; saving keeps the amount the person typed.
    const write = weighInInput(field.text, date, undefined, field.unit);
    if (write.refusal) {
      gymStep('bodyweight-save', 'refused');
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
            aria-label={`${BODYWEIGHT_TITLE} in ${unit}`}
            onChange={(event) => { setField({ text: event.target.value, unit }); setRefusal(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
            autoFocus
          />
          <span className="gym-weigh-unit">{unit}</span>
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
              max={gymMoment(now).today.text}
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
// door onto a new weigh-in here; that is the Weigh in action on the log, one back away.
export function BodyweightScreen({ log }) {
  const weights = useBodyweight(log);
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW);
  const [fixing, setFixing] = useState(null);
  const chart = weights.weights?.chart(windowId === 'all' ? 'all' : 'recent');
  const shown = (chart?.dots ?? []).map((entry) => ({ dateLocal: entry.day.text, weightKg: entry.kg }));
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

      {weights.phase === 'ready' && weights.weights?.stance === 'empty' && (
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
            points={chartPointsOf(shown, weights.unit)}
            domain={chartDomainOf(weights.weights, windowId)}
            joins={(from, to) => !chart.gaps.some((gap) => gap.after.text === from.dateLocal && gap.before.text === to.dateLocal)}
            gapLabel={gapLabel}
            formatValue={(value) => axisValue(value, weights.unit)}
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
          unit={weights.unit}
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
