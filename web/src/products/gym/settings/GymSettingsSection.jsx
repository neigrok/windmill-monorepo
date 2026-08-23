import React, { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../design-system';
import { listMcpKeys } from '../../../shell/auth/McpKeyClient.js';
import { listGrants } from '../../../shell/auth/OAuthClient.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { connectedLabel, connectionsToTheLog, NOTHING_CONNECTED } from '../connect/connect.js';
import { EXPORT_HREF, gymApi } from '../gymApi.js';
import { CONNECT_HREF } from '../log.js';
import { LB, spellWeightsIn, UNITS } from '../units.js';
import {
  preferenceRefusal, preferencesWrite, readPreferences, REST_CHOICES, restLabel,
} from './preferences.js';

export function GymSettingsSection({ api = gymApi } = {}) {
  const [preferences, setPreferences] = useState(null);
  const [hasLog, setHasLog] = useState(false);
  const [refused, setRefused] = useState('');
  // The document the store last confirmed; a ref, so a reverting reply cannot close over a stale copy.
  const stored = useRef(null);
  // An older reply landing after a newer one must not redraw the row.
  const write = useRef(0);
  const confirmed = useRef(0);

  useEffect(() => {
    let live = true;
    api.preferences()
      .then((document) => {
        if (!live) return;
        const held = readPreferences(document);
        stored.current = held;
        setPreferences(held);
        spellWeightsIn(held.units);
      })
      .catch(() => {});
    api.sessions({ limit: 1 })
      .then((sessions) => { if (live) setHasLog(sessions.length > 0); })
      .catch(() => {});
    return () => { live = false; };
  }, [api]);

  if (!preferences) return null;

  const change = async (edit) => {
    const next = { ...preferences, ...edit };
    setPreferences(next);
    spellWeightsIn(next.units);
    setRefused('');
    const mine = write.current + 1;
    write.current = mine;
    try {
      const answered = readPreferences(await api.savePreferences(preferencesWrite(next)));
      if (mine > confirmed.current) {
        confirmed.current = mine;
        stored.current = answered;
      }
      if (write.current !== mine) return;
      setPreferences(answered);
      spellWeightsIn(answered.units);
    } catch (error) {
      if (write.current !== mine) return;
      setPreferences(stored.current);
      spellWeightsIn(stored.current.units);
      setRefused(preferenceRefusal(error));
    }
  };

  return (
    <Section title="Your training log">
      <Row title="Units" aside={<Choices options={UNITS} value={preferences.units} onPick={(units) => change({ units })} />}>
        Display only — nothing stored changes.
        {preferences.units === LB && (
          <> Weights you type at this desk — a backfill, a correction, a routine target — stay in
            kilograms, and say so on the field.
          </>
        )}
      </Row>

      <Row title="Rest timer" aside={<span style={look.aside}>{restLabel(preferences.restSeconds)}</span>}>
        <Choices
          options={REST_CHOICES}
          value={preferences.restSeconds}
          label={restLabel}
          onPick={(restSeconds) => change({ restSeconds })}
        />
        <div style={look.switchRow}>
          <Switch
            checked={preferences.restSound}
            onChange={(restSound) => change({ restSound })}
            label="Sound when it ends"
          />
        </div>
        {preferences.restSeconds == null && 'Off, and off is the default. '}
        Whichever target you set, your phone runs the clock between sets and sounds it. This page
        never sounds an alarm of its own.
      </Row>

      <Row title="Set confirmation">
        <div style={look.switchRow}>
          <Switch checked={preferences.confirmHaptic} onChange={(confirmHaptic) => change({ confirmHaptic })} label="Haptic" />
        </div>
        <div style={look.switchRow}>
          <Switch checked={preferences.confirmSound} onChange={(confirmSound) => change({ confirmSound })} label="Sound" />
        </div>
        Sets are logged on your phone, and that is where these are honoured — a haptic where the
        platform has one, a sound where it does not. No set is logged at this desk, so nothing here
        buzzes or beeps either way; the switch records what you want, it does not act here.
      </Row>

      {hasLog && (
        <a href={EXPORT_HREF} style={look.door}>
          <span style={look.doorMain}>
            <span style={styles.primaryText}>Export</span>
            <span style={styles.metaText}>every set as CSV · yours, always</span>
          </span>
          <span aria-hidden="true" style={look.chevron}>›</span>
        </a>
      )}

      <ConnectedLog />

      {refused && <p style={look.refused}>{refused}</p>}
    </Section>
  );
}

export default GymSettingsSection;

function ConnectedLog() {
  const [connections, setConnections] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([listGrants(), listMcpKeys()])
      .then(([grants, keys]) => { if (live) setConnections(connectionsToTheLog(grants, keys)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <a href={CONNECT_HREF} style={{ ...look.door, borderColor: 'var(--color-brand)' }}>
      <span style={look.doorMain}>
        <span style={{ ...styles.primaryText, color: 'var(--color-brand)' }}>Connected log</span>
        {connections?.length > 0 && (
          <span style={styles.metaText}>
            {connections.map((row) => `${row.name} · ${connectedLabel(row)}`).join('   ·   ')}
          </span>
        )}
        {connections?.length === 0 && <span style={styles.metaText}>{NOTHING_CONNECTED}</span>}
      </span>
      <span aria-hidden="true" style={{ ...look.chevron, color: 'var(--color-brand)' }}>›</span>
    </a>
  );
}

function Row({ title, aside, children }) {
  return (
    <div style={look.row}>
      <div style={look.head}>
        <span style={styles.primaryText}>{title}</span>
        {aside}
      </div>
      {/* A div and not a paragraph: these rows nest controls, which a <p> would reshape around. */}
      <div style={{ ...styles.calmLine, marginTop: 8 }}>{children}</div>
    </div>
  );
}

function Choices({ options, value, label = String, onPick }) {
  return (
    <span style={look.choices}>
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          aria-pressed={option === value}
          onClick={() => onPick(option)}
          style={option === value ? { ...look.choice, ...look.choiceOn } : look.choice}
        >
          {label(option)}
        </button>
      ))}
    </span>
  );
}

const look = {
  row: { padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  aside: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
  },
  choices: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  choice: {
    minWidth: 54, padding: '5px 12px',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-full)',
    background: 'transparent', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer',
  },
  choiceOn: { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft)' },
  switchRow: { margin: '10px 0 2px' },
  door: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
    borderBottom: '1px solid var(--border-subtle)', textDecoration: 'none',
  },
  doorMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  chevron: { fontSize: 18, color: 'var(--text-tertiary)' },
  refused: { ...styles.calmLine, marginTop: 10, color: 'var(--color-danger)' },
};
