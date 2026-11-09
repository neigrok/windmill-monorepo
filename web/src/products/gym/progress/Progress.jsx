import React, { useState } from 'react';
import { DotChart } from '../../../design-system/index.js';
import { t } from '../i18n/index.js';
import { fmt, recordHref, setLoadLabel, shortDayLabel } from '../log.js';
import { weightUnit } from '../units.js';
import { estimateValue, joinsSessions, movementProgress, POINT_PITCH_PT, progressDateLabel, progressCards, SCRUB_HOLD_MS, sessionGapLabel } from './progress.js';
import './progress.css';

function axisLabel(value) {
  const rounded = Math.round(value * 10) / 10;
  return String(Number.isFinite(rounded) ? rounded : value);
}

export function ProgressCards({ log, from = { screen: 'log' }, readOnly = false, unit = weightUnit() }) {
  const progress = log.progress;
  if (!progress || progress.phase === 'loading') return null;
  const cards = progressCards(progress.data, log.catalog, Date.now(), unit);
  const Card = readOnly ? 'article' : 'a';
  return (
    <section className="gym-progress" aria-label={t('gym.progress.byMovement')}>
      <div className="gym-progress-grid">
        {cards.map((card) => {
          const lines = [card.latestLine, card.bestLine, card.heaviestLine, card.mostRepsLine, card.sparseLine].filter(Boolean).join('. ');
          return <Card className="gym-progress-card" key={card.exerciseId} href={readOnly ? undefined : recordHref(card.exerciseId, from)}
            aria-label={readOnly ? t('gym.progress.cardLabel', { name: card.name, lines }) : t('gym.progress.cardLabelDoor', { name: card.name, lines })}>
            <h3>{card.name}{!readOnly && <img src={new URL('../logbook/assets/record-door.svg', import.meta.url).href} width="12" height="12" alt="" />}</h3>
            {card.chartReady ? <>
              <DotChart points={card.points} domain={card.domain} joins={joinsSessions} gapLabel={sessionGapLabel} formatValue={axisLabel} formatDate={shortDayLabel} height={90} axisFontSize={13} compact ariaLabel={card.windowLabel} />
              <p className="gym-progress-window">{card.windowLabel}</p>
              <p className={card.latest?.sessionId === card.best?.sessionId ? 'is-record' : undefined}>{card.latestLine}</p>
              <p>{card.heaviestLine}</p>
              {card.latest?.sessionId !== card.best?.sessionId && <p className="is-record">{card.bestLine}</p>}
            </> : <>
              {card.assisted && card.mostRepsLine && <p>{card.mostRepsLine}</p>}
              {card.assisted && card.signedLoadLine && <p>{card.signedLoadLine}</p>}
              {card.sparseBest && <p className="gym-progress-sparse">{card.sparseBest}</p>}
              <p className="gym-progress-count">{card.sparseLine}</p>
              {!card.best && !card.assisted && card.heaviestLine && <p>{card.heaviestLine}</p>}
            </>}
          </Card>;
        })}
      </div>
    </section>
  );
}

export function MovementChart({ id, log, equipment }) {
  const [window, setWindow] = useState('12');
  const progress = log.progress;
  if (!progress || progress.phase === 'loading') return <p className="gym-quiet">{t('gym.progress.opening')}</p>;
  const model = movementProgress(progress.data, id, { window, equipment });
  const dateLabel = (at) => progressDateLabel(at, model.showYears);
  return <section className="gym-movement-progress">
    <div className="gym-window" aria-label={t('gym.progress.chartWindow')}>
      {[['12', t('gym.progress.twelveWeeks')], ['all', t('gym.progress.all')]].map(([value, label]) => <button type="button" key={value} aria-pressed={window === value} onClick={() => setWindow(value)}>{label}</button>)}
    </div>
    {model.points.length ? <>
      <section className="gym-record-chart" aria-label={t('gym.progress.estimatedStrength')}>
        <h2>{t('gym.progress.e1rmPerSession')}</h2>
        <DotChart points={model.points} domain={model.domain} joins={joinsSessions} gapLabel={(from, to) => t('gym.progress.gapCapital', { from: dateLabel(from.at), to: dateLabel(to.at) })} formatValue={axisLabel} formatDate={dateLabel} ariaLabel={model.windowLabel} axisFontSize={13} interactive minimal pointPitch={POINT_PITCH_PT} holdMs={SCRUB_HOLD_MS} />
        <p>{t('gym.log.sessionCount', { count: model.points.length })}</p><p className="gym-chart-disclosure">{t('gym.progress.disclosure')}</p>
      </section>
      <p className="gym-record-latest">{t('gym.progress.latestLine', { estimate: estimateValue(model.latest.estimate.e1rm), unit: weightUnit(), set: setLoadLabel(model.latest.estimate) })}</p>
      {model.best && <p className="gym-record-best">{model.latest.sessionId !== model.best.sessionId && model.latest.estimate.e1rm === model.best.estimate.e1rm
        ? t('gym.progress.bestMatched', { estimate: estimateValue(model.best.estimate.e1rm), unit: weightUnit(), date: dateLabel(model.best.at), matched: dateLabel(model.latest.at) })
        : t('gym.progress.bestLine', { estimate: estimateValue(model.best.estimate.e1rm), unit: weightUnit(), date: dateLabel(model.best.at) })}</p>}
      <table className="gym-record-series"><thead><tr><th>{t('gym.progress.date')}</th><th>{t('gym.progress.topSet', { unit: weightUnit() })}</th><th>{t('gym.progress.e1rm')}</th></tr></thead><tbody>{model.sessions.filter((session) => session.estimate).map((session) => {
        const estimate = estimateValue(session.estimate.e1rm);
        return <tr key={session.sessionId}><td>{dateLabel(session.at)}</td><td><span className="gym-record-set"><span>{fmt(session.estimate.weightKg)}</span><span>×</span><span>{session.estimate.reps}</span></span></td><td className={session.sessionId === model.best?.sessionId ? 'is-record' : undefined}>{estimate === '—' ? estimate : Number(estimate).toFixed(1)}</td></tr>;
      })}</tbody></table>
    </> : <section className="gym-record-chart">
      {model.assisted && model.mostRepsLine && <p className="gym-record-latest">{model.mostRepsLine}</p>}
      {model.assisted && model.signedLoadLine && <p className="gym-record-latest">{model.signedLoadLine}</p>}
      {!model.assisted && model.heaviestLine && <p className="gym-record-latest">{model.heaviestLine}</p>}
      <p>{model.sparseLine}</p>
      {!model.assisted && model.estimateAbsenceKnown && <p>{t('gym.progress.noEstimate')}</p>}
    </section>}
  </section>;
}
