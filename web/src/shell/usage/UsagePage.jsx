// /app/usage — the owner's spend meter, and the least-visited room in the product. Two founders
// bookmark one URL: there is no rail item, no seat row and no link to it anywhere, and it is not a
// legacy door either, because nothing emits a #/usage hash and a second address for one room is a
// second thing that has to stay true.
//
// THE ROOM HAS EXACTLY ONE GATE, AND IT IS THE SERVER'S. The endpoints answer 404 byte-identically
// for signed-out, signed-in-non-owner and unknown, so this page fetches, and on `not_found` does
// precisely what any other unrecognised /app path does — replaces into /app. No owner flag is read
// (there is none, deliberately), no chrome is drawn conditionally, and nothing on the way in tells a
// visitor who should not be here that there is anything here to be told about.
//
// THE PANELS ARE LOCAL COMPONENTS. Each has one caller — this file — and a separate file per panel
// would be exactly the single-call-site indirection the house rules say to inline. What is NOT local
// is the arithmetic: every number and every sentence below comes out of usage.js, which is pure and
// is where this room is actually tested.

import React from 'react';
import { Badge, BarSeries, ShareBar } from '../../design-system';
import { fetchSpenders, fetchSummary } from './UsageClient.js';
import { usageView, windowsFor } from './usage.js';
import './usage.css';

export function UsagePage() {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState({ phase: 'loading' });

  React.useEffect(() => {
    let live = true;
    // One instant for all three reads, so the current window and the prior one meet exactly and the
    // comparison is between two spans of the same length with nothing between them.
    const { current, prior } = windowsFor(Date.now());
    Promise.all([
      fetchSummary(current),
      fetchSpenders(current),
      // The prior window buys one line — the delta. A hiccup on it costs that line and nothing else,
      // and never a comparison we made up to fill the space.
      fetchSummary(prior).catch(() => null),
    ])
      .then(([summary, spenders, priorSummary]) => {
        if (live) setState({ phase: 'ready', view: usageView({ summary, prior: priorSummary, spenders, window: current }) });
      })
      .catch((error) => {
        if (live) setState({ phase: error?.code === 'not_found' ? 'missing' : 'failed' });
      });
    return () => { live = false; };
  }, [attempt]);

  React.useEffect(() => {
    if (state.phase !== 'missing') return;
    // What /app/anything-else does, done by the same two calls the shell makes: swap the pathname
    // and wake the router. A reader who was never meant to find this room lands on the app home,
    // which is where a typo lands too.
    window.history.replaceState({}, '', '/app');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [state.phase]);

  if (state.phase === 'missing') return null;
  if (state.phase === 'failed') {
    return (
      <section className="wm-usage">
        <p className="wm-usage-quiet">
          The ledger didn’t load.
          <button type="button" className="wm-usage-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      </section>
    );
  }
  if (state.phase !== 'ready') {
    return (
      <section className="wm-usage">
        <p className="wm-usage-quiet">Reading the ledger…</p>
      </section>
    );
  }

  const { header, runRate, honesty, daily, products, spenders } = state.view;
  return (
    <section className="wm-usage">
      <header className="wm-usage-head">
        <h1 className="wm-usage-title">{header.title}</h1>
        {/* The window and the currency are stated ONCE, here, at the top — not repeated beside every
            figure, and never re-decided by a picker this page deliberately does not have. */}
        <p className="wm-usage-sub">{`${header.window} · ${header.note}`}</p>
      </header>

      <RunRate runRate={runRate} />
      <Honesty honesty={honesty} />

      <section className="wm-usage-panel">
        <BarSeries
          title={daily.title}
          bars={daily.bars}
          max={daily.max}
          floorLabel={daily.floorLabel}
          ceilingLabel={daily.ceilingLabel}
          tone={daily.tone}
        />
      </section>

      <section className="wm-usage-panel">
        <h2 className="wm-usage-panel-title">{products.title}</h2>
        <ShareBar segments={products.segments} total={products.total} summary={products.summary} />
      </section>

      <Spenders spenders={spenders} />
    </section>
  );
}

// PANEL 1. The one large number, and the two figures that give it a direction — is this week's spend
// different, and by how much. Everything below this panel exists to explain a change this one shows.
function RunRate({ runRate }) {
  return (
    <section className="wm-usage-panel wm-usage-rate">
      <p className="wm-usage-total">{runRate.headline}</p>
      <div className="wm-usage-beside">
        {runRate.projection && (
          <p className="wm-usage-aside">
            <span className="wm-usage-aside-value">{runRate.projection.value}</span>
            <span className="wm-usage-aside-label">{runRate.projection.label}</span>
          </p>
        )}
        {runRate.delta && <p className={`wm-usage-delta wm-usage-delta-${runRate.delta.direction}`}>{runRate.delta.text}</p>}
      </div>
      <p className="wm-usage-subline">{runRate.subline}</p>
    </section>
  );
}

// PANEL 2, and it is second on purpose: a caveat found underneath a chart, after the number at the
// top has been read and believed, arrived too late to change what anybody did about it. A clean
// window is one calm line; anything else is a strip with a border, and the strip's tone separates
// "the meter is under-counting and cannot say by how much" from "some spend has no account behind
// it, which is the birth canvas working as designed".
function Honesty({ honesty }) {
  if (honesty.tone === 'plain') return <p className="wm-usage-clean">{honesty.lines[0]}</p>;
  return (
    <section className={`wm-usage-strip wm-usage-strip-${honesty.tone}`}>
      {honesty.lines.map((line) => <p className="wm-usage-strip-line" key={line}>{line}</p>)}
    </section>
  );
}

// PANEL 5. A plain semantic table, because that is what a ranked list of ten people is — no sorting,
// no filtering, no drill-down: none of the three supports a decision made on a Monday morning.
function Spenders({ spenders }) {
  return (
    <section className="wm-usage-panel">
      <h2 className="wm-usage-panel-title">{spenders.title}</h2>
      {spenders.rows.length === 0 ? (
        <p className="wm-usage-quiet">No account spent anything in this window.</p>
      ) : (
        <table className="wm-usage-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="wm-usage-num">Cost</th>
              <th scope="col" className="wm-usage-num">Calls</th>
              <th scope="col">Top product</th>
            </tr>
          </thead>
          <tbody>
            {spenders.rows.map((row) => (
              <tr key={row.key}>
                <td>{row.email}</td>
                <td className="wm-usage-num">
                  {row.cost}
                  {row.badge && <span title={row.badge.title}><Badge tone="warning">{row.badge.text}</Badge></span>}
                </td>
                <td className="wm-usage-num">{row.calls}</td>
                <td>{row.topProduct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* The unattributed aggregate lives HERE and never as a row above: that table is a list of
          people, and a total with no person behind it sitting among them is read as a person. */}
      {spenders.caption && <p className="wm-usage-caption">{spenders.caption}</p>}
    </section>
  );
}

export default UsagePage;
