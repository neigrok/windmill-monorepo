// Settings · Your training log — §I's five rows, and they are all about a barbell: units, what
// plates this gym owns, how long the rest is, how a logged set confirms itself, and the two doors
// out (the CSV, and the tool that reads the log). Nothing here restates an account screen: profile,
// appearance, plan, sessions, devices, the account's own export and its close are all on this page
// already, above and below, and gym has no theme switch of its own.
//
// The section is registered through routes.js and composed by a settings page that never names the
// gym. It stays in the `data` slot for the reason the close's own consent list gives — "export what
// you want to keep first", meaning the product exports directly above it.
//
// WHO IT DRAWS FOR CHANGED THIS WAVE, and the old reason survives inside the new one. This used to
// draw nothing at all until one read said the account had a log, so that somebody who has only ever
// grown skill trees was never offered a file of a training log they never kept. That reason is about
// the EXPORT, and the export row still carries it. The four rows above it are how the room behaves
// at the rack — a lifter setting their bar and their plates before their first session is the normal
// case, not the exception — so they are drawn for anyone signed in. A read that does not come back
// still draws nothing: a toggle whose stored state is unknown is a control that would lie.
//
// EVERY CHANGE IS A WHOLE-DOCUMENT PUT, sent the moment it is made and redrawn off what comes back
// (preferences.js). There is no Save button because there is nothing to hold: each row is one value,
// and the store's answer — plates normalised heaviest-first, an unknown unit clamped — is the truth
// the screen shows. A refusal reverts to the stored document and says the store's own sentence,
// which names the band the value fell outside.

import React, { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../design-system';
import { listGrants } from '../../../shell/auth/OAuthClient.js';
import { readScope } from '../../../shell/auth/scopes.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { EXPORT_HREF, gymApi } from '../gymApi.js';
import { fmtKg, shortDayLabel } from '../log.js';
import { LB, spellWeightsIn, UNITS } from '../units.js';
import { finestStepKg } from './plates.js';
import {
  BAR_MAX_KG, PLATE_CHOICES, preferenceRefusal, preferencesWrite, readPreferences, REST_CHOICES,
  restLabel, withPlate,
} from './preferences.js';

export function GymSettingsSection({ api = gymApi } = {}) {
  const [preferences, setPreferences] = useState(null);
  const [hasLog, setHasLog] = useState(false);
  const [refused, setRefused] = useState('');
  // The document the store last confirmed, and what a refused write goes back to. A ref because it
  // is never drawn — what is on screen is the optimistic copy above — and because the reply that
  // reverts is written from inside a promise that would otherwise close over a stale one.
  const stored = useRef(null);
  // Which write is the live one. Rows move faster than a round trip, so an older reply landing after
  // a newer one would draw a setting the lifter has already moved past.
  const write = useRef(0);

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
      if (write.current !== mine) return;
      stored.current = answered;
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
        Changes the display, never the stored value. History does not get rewritten — every weight in
        your log is the kilogram it was logged as.
        {preferences.units === LB && (
          <> Weights you type at this desk — a backfill, a correction, a routine target — stay in
            kilograms and say so on the field, because nothing here converts a number on its way into
            the log.
          </>
        )}
      </Row>

      <Row title="Plate math" aside={<BarWeight preferences={preferences} onChange={change} />}>
        <Plates preferences={preferences} onChange={change} />
        What your gym actually owns. It is what the readout under a load reads from — the tap ladder
        is the same everywhere and does not move, so this is what says whether a weight can be built
        rather than what it is allowed to be. {finestStepLine(preferences.platesKg)}
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
        {/* WHERE THE SWITCH IS HONOURED IS SAID IN EVERY STATE, and off is the state every lifter
            sees first: the sentence naming the phone sat in the other branch, so the default screen
            drew a live "Sound when it ends" beside nothing that said where it sounds. */}
        {preferences.restSeconds == null
          && 'Off, and off is the default — a timer nobody asked for that starts beeping in a gym is not something this product does. '}
        Whichever target you set, your phone runs the clock between sets and sounds it, because that
        is where the sets are logged. This page mirrors a session it is not capturing, so it names
        the target and never sounds an alarm of its own — a browser tab cannot promise one that
        survives a locked screen.
      </Row>

      <Row title="Set confirmation">
        <div style={look.switchRow}>
          <Switch checked={preferences.confirmHaptic} onChange={(confirmHaptic) => change({ confirmHaptic })} label="Haptic" />
        </div>
        <div style={look.switchRow}>
          <Switch checked={preferences.confirmSound} onChange={(confirmSound) => change({ confirmSound })} label="Sound" />
        </div>
        {/* THE LIMIT IS THIS SURFACE, NOT THE BROWSER, and the row has to say the true one. It read
            "this browser has no Vibration API", which is the design's own caption and is false where
            the gym PWA installs: Chrome on Android has `navigator.vibrate` and honours it. What is
            actually true is that nothing is LOGGED here — the web is the mirror and the desk (§11),
            so there is no confirmed set for either of these to answer, and no reading of `navigator`
            would change that. A row that gave a false reason would be believed by the next person to
            decide whether this desk could buzz after all. */}
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

      <p style={{ ...styles.metaText, marginTop: 12 }}>
        Account, appearance, plan, sessions, devices, export-everything and closing the account are on
        this page already. Gym does not restate them, and it has no theme switch of its own.
      </p>
    </Section>
  );
}

export default GymSettingsSection;

// THE ROW THAT NAMES THE GRANT STATE, and it names it rather than owning it: the grant itself lives
// once, in the shell's own Connected tools section and the /connect workbench, so this reads which
// tools reach the training log and walks there. Rebuilding a revoke here would be a second door onto
// one decision.
//
// A read that did not come back says nothing about the state. The door still stands — it is a place
// to go, not a claim — and no sentence under it invents a connection or denies one.
function ConnectedLog() {
  const [grants, setGrants] = useState(null);

  useEffect(() => {
    let live = true;
    listGrants()
      .then((rows) => { if (live) setGrants(rows.filter(reachesTheLog)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <a href="#/connect" style={{ ...look.door, borderColor: 'var(--color-brand)' }}>
      <span style={look.doorMain}>
        <span style={{ ...styles.primaryText, color: 'var(--color-brand)' }}>Connected log</span>
        {grants?.length > 0 && (
          <span style={styles.metaText}>
            {grants.map((grant) => `${grant.name} · connected ${shortDayLabel(grant.grantedMs)}`).join('   ·   ')}
          </span>
        )}
        {grants?.length === 0 && <span style={styles.metaText}>No tool reads your log yet.</span>}
      </span>
      <span aria-hidden="true" style={{ ...look.chevron, color: 'var(--color-brand)' }}>›</span>
    </a>
  );
}

// The legacy account-wide grant reaches every product, including this one — a token minted before
// scopes existed carries an empty scope and is not a token that reaches nothing.
function reachesTheLog(grant) {
  const scope = readScope(grant.scope);
  return scope.accountWide || scope.products.some((each) => each.product === 'gym');
}

function Row({ title, aside, children }) {
  return (
    <div style={look.row}>
      <div style={look.head}>
        <span style={styles.primaryText}>{title}</span>
        {aside}
      </div>
      {/* A div and not a paragraph: two of these rows put controls above their sentence, and a
          control nested in a <p> is markup the browser silently reshapes around. */}
      <div style={{ ...styles.calmLine, marginTop: 8 }}>{children}</div>
    </div>
  );
}

// One value, chosen from a short row of them — units, and the four rest targets. `null` is a value
// like any other here, which is what lets "off" be a choice rather than an absence with a switch
// beside it.
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

// The bar is typed and not stepped, because it is set once for a rack and then never touched — and
// it is committed on the way OUT of the field rather than on every keystroke, so a 20 becoming a 25
// is one write and not a write at 2. A number the field cannot read goes back to the stored one:
// this is a rack's bar, and there is no half-typed value worth keeping on screen.
//
// ZERO IS LEGAL and is not an empty field: a pair of dumbbells and a machine have no bar.
function BarWeight({ preferences, onChange }) {
  const [typed, setTyped] = useState(null);
  const shown = typed ?? fmtKg(preferences.barWeightKg);

  const commit = () => {
    const raw = String(shown).trim();
    setTyped(null);
    // AN EMPTY FIELD IS NOT A ZERO, and this is the one guard that matters: zero is a legal bar —
    // a machine, a pair of dumbbells — so `Number('')` would sail through the band below and store
    // a bar nobody typed on the way to typing another one.
    if (raw === '') return;
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > BAR_MAX_KG) return;
    if (value !== preferences.barWeightKg) onChange({ barWeightKg: value });
  };

  return (
    <span style={look.aside}>
      bar
      <input
        value={shown}
        inputMode="decimal"
        aria-label="Bar weight in kilograms"
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.target.blur(); }}
        style={look.barField}
      />
      kg
    </span>
  );
}

function Plates({ preferences, onChange }) {
  return (
    <span style={look.chips}>
      {PLATE_CHOICES.map((plate) => {
        const owned = preferences.platesKg.includes(plate);
        return (
          <button
            key={plate}
            type="button"
            aria-pressed={owned}
            onClick={() => onChange({ platesKg: withPlate(preferences.platesKg, plate) })}
            style={owned ? { ...look.chip, ...look.chipOn } : look.chip}
          >
            {fmtKg(plate)}
          </button>
        );
      })}
    </span>
  );
}

// The true version of the design's "the ladder's fine step comes from this": the ladder does not
// move, and what the rack decides is the smallest change that can actually go on the bar — twice the
// lightest plate, because one goes on each end.
function finestStepLine(platesKg) {
  const step = finestStepKg(platesKg);
  if (step == null) return 'With no plates, the bar is the only load this rack makes.';
  return `The smallest change these make is ${fmtKg(step)} kg — ${fmtKg(step / 2)} a side.`;
}

const look = {
  row: { padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  aside: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
  },
  barField: {
    width: 52, padding: '3px 6px', textAlign: 'right',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
    background: 'var(--surface-card)', color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
  },
  choices: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  choice: {
    minWidth: 54, padding: '5px 12px',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-full)',
    background: 'transparent', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer',
  },
  choiceOn: { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft)' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 2px' },
  chip: {
    padding: '6px 12px',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-full)',
    background: 'transparent', color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer',
  },
  chipOn: { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft)' },
  switchRow: { margin: '10px 0 2px' },
  door: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
    borderBottom: '1px solid var(--border-subtle)', textDecoration: 'none',
  },
  doorMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  chevron: { fontSize: 18, color: 'var(--text-tertiary)' },
  refused: { ...styles.calmLine, marginTop: 10, color: 'var(--color-danger)' },
};
