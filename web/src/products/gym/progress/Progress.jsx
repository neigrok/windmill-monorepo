import React, { useState } from 'react';
import { Button, DotChart } from '../../../design-system/index.js';
import { recordHref, setLoadLabel, shortDayLabel } from '../log.js';
import { weightUnit } from '../units.js';
import { estimateValue, joinsSessions, movementProgress, POINT_PITCH_PT, progressDateLabel, progressCards, SCRUB_HOLD_MS, sessionGapLabel } from './progress.js';

export function ProgressCards({ log, from = { screen: 'log' }, readOnly = false, unit = weightUnit() }) {
  const progress = log.progress;
  if (!progress || progress.phase === 'loading') return null;
  const cards = progressCards(progress.data, log.catalog, Date.now(), unit);
  const Card = readOnly ? 'article' : 'a';
  return (
    <section className="gym-progress" aria-label="Progress by movement">
      {progress.phase === 'failed' && <p className="gym-read-failed">Progress didn’t load. <Button size="sm" variant="secondary" onClick={log.reloadProgress}>Retry</Button></p>}
      <div className="gym-progress-grid">
        {cards.map((card) => (
          <Card className="gym-progress-card" key={card.exerciseId} href={readOnly ? undefined : recordHref(card.exerciseId, from)} aria-label={`${card.name}. ${[card.latestLine, card.bestLine, card.heaviestLine, card.mostRepsLine, card.sparseLine].filter(Boolean).join('. ')}.${readOnly ? '' : ' Opens this movement’s record.'}`}>
            <h3>{card.name}{!readOnly && <img src={new URL('../logbook/assets/record-door.svg', import.meta.url).href} width="12" height="12" alt="" />}</h3>
            {card.chartReady ? <>
              <DotChart points={card.points} domain={card.domain} joins={joinsSessions} gapLabel={sessionGapLabel} formatValue={(value) => String(Math.round(value * 10) / 10)} formatDate={shortDayLabel} height={64} axisFontSize={13} compact ariaLabel={card.windowLabel} />
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
          </Card>
        ))}
      </div>
    </section>
  );
}

export function MovementChart({ id, log, equipment }) {
  const [window, setWindow] = useState('12');
  const progress = log.progress;
  if (!progress || progress.phase === 'loading') return <p className="gym-quiet">Opening progress…</p>;
  const model = movementProgress(progress.data, id, { window, equipment });
  const dateLabel = (at) => progressDateLabel(at, model.showYears);
  return <section className="gym-movement-progress">
    <div className="gym-window" aria-label="Chart window">
      {[['12', '12 weeks'], ['all', 'All']].map(([value, label]) => <button type="button" key={value} aria-pressed={window === value} onClick={() => setWindow(value)}>{label}</button>)}
    </div>
    {progress.phase === 'failed' && <p className="gym-read-failed">Progress didn’t load. <Button size="sm" variant="secondary" onClick={log.reloadProgress}>Retry</Button></p>}
    {model.points.length ? <>
      <section className="gym-record-chart" aria-label="Estimated strength">
        <h2>e1RM per session</h2>
        <DotChart points={model.points} domain={model.domain} joins={joinsSessions} gapLabel={(from, to) => sessionGapLabel(from, to, model.showYears)} formatValue={(value) => String(Math.round(value * 10) / 10)} formatDate={dateLabel} ariaLabel={model.windowLabel} axisFontSize={13} interactive pointPitch={POINT_PITCH_PT} holdMs={SCRUB_HOLD_MS} />
        <p>{model.windowLabel}</p><p className="gym-chart-disclosure">Estimates, not tested lifts.</p>
      </section>
      <p className="gym-record-latest">Latest · {estimateValue(model.latest.estimate.e1rm)} {weightUnit()} est · {setLoadLabel(model.latest.estimate)}</p>
      <p className="gym-record-best">Best {estimateValue(model.best.estimate.e1rm)} {weightUnit()} est · {dateLabel(model.best.at)}{model.latest.sessionId !== model.best.sessionId && model.latest.estimate.e1rm === model.best.estimate.e1rm ? ` · matched ${dateLabel(model.latest.at)}` : ''}</p>
      <table className="gym-record-series"><thead><tr><th>Date</th><th>Top set · {weightUnit()}</th><th>e1RM</th></tr></thead><tbody>{model.sessions.filter((session) => session.estimate).map((session) => <tr key={session.sessionId}><td>{dateLabel(session.at)}</td><td>{setLoadLabel(session.estimate)}</td><td className={session.sessionId === model.best.sessionId ? 'is-record' : undefined}>{estimateValue(session.estimate.e1rm)}</td></tr>)}</tbody></table>
    </> : <section className="gym-record-chart">
      {model.assisted && model.mostRepsLine && <p className="gym-record-latest">{model.mostRepsLine}</p>}
      {model.assisted && model.signedLoadLine && <p className="gym-record-latest">{model.signedLoadLine}</p>}
      {!model.assisted && model.heaviestLine && <p className="gym-record-latest">{model.heaviestLine}</p>}
      <p>{model.sparseLine}</p>
      {!model.assisted && <p>No estimate in this window.</p>}
    </section>}
  </section>;
}
