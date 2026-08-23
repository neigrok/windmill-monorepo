import React from 'react';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { relativeTime, shortDate } from '../../../shell/settings/format.js';
import { fetchTending } from '../tending/tendingClient.js';
import { receiptLine, meterPct } from '../tending/receipts.js';

export function TendingSection() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    fetchTending().then((next) => {
      if (!alive) return;
      setData(next);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // A dark server, a signed-out read and a failed one all mean the same thing: there is no meter.
  if (loading || !data || !data.enabled) return null;

  const { plan, limit, used, remaining, resetAtMs, runs = [] } = data;
  const pct = meterPct(used, limit);

  return (
    <Section title="Tending">
      <div style={{ padding: '2px 0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <span style={styles.primaryText}>{remaining} of {limit} left this month</span>
          {plan === 'pro' && <span style={styles.tag}>PRO</span>}
        </div>
        <div style={bar}><span style={{ ...barFill, width: `${pct}%` }} /></div>
        <div style={{ ...styles.metaText, marginTop: 6 }}>
          {used} used · resets {shortDate(resetAtMs)}. Hand editing is always free.
        </div>
      </div>

      {runs.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {runs.map((run) => (
            <div key={run.id} style={styles.row}>
              <div style={styles.rowMain}>
                <div style={styles.primaryText}>{receiptLine(run)}</div>
                {run.prompt && <div style={styles.metaText}>{run.prompt}</div>}
              </div>
              <span style={{ ...styles.metaText, flex: 'none' }}>{relativeTime(run.startedAtMs)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ ...styles.calmLine, marginTop: 10 }}>No tendings yet this month.</p>
      )}
    </Section>
  );
}

export default TendingSection;

const bar = {
  height: 8, borderRadius: 'var(--radius-full)', background: 'var(--surface-sunken)',
  overflow: 'hidden', marginTop: 8,
};
const barFill = {
  display: 'block', height: '100%', borderRadius: 'var(--radius-full)',
  background: 'linear-gradient(90deg, var(--accent-terracotta-400), var(--color-brand))',
  transition: 'width var(--duration-base) var(--ease-soft)',
};
