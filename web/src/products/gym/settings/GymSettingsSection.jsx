import React, { useEffect, useId, useRef, useState } from 'react';
import { Select, Switch } from '../../../design-system/index.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { useSyncReplica } from '../../../platform/sync/react.js';
import { Section, styles, useSettingsSeat } from '../../../shell/settings/Section.jsx';
import { Preferences, PreferencesValue, restSettings } from '../domain/preferences.js';
import { TrainingLog } from '../domain/trainingReads.js';
import { WorkoutRack } from '../domain/workoutRack.js';
import { failureReason } from '../errors.js';
import { useGymApi } from '../gymRuntime.js';
import { t } from '../i18n/settings/index.js';
import { clockOf, NOTES_HREF } from '../log.js';
import { HEAD_LINE, NOTES_TITLE } from '../notes/notes.js';
import { LB, spellWeightsIn, UNITS, unitSymbol } from '../units.js';
import { useDomainRead } from '../useDomainRead.js';

// Off, then the routine editor's rests (iOS MovementForm.rests), so the default is never a rest a routine cannot show; a
// stored rest outside them, which only another door writes, is offered where it falls.
const RESTS = Object.freeze([30, 60, 90, 120, 150, 180, 240, 300]);
const OFF = 'off';
const SAVED = 'saved';
const SAVED_FOR_MS = 1600;

// Your training log in Settings (WD10), on the copy of the seat the tab draws: the account's signed in, the browser's own
// signed out. It draws nothing until that copy is ready, so a bound replica's first pull never shows a fresh copy's
// settings as the account's. Each setting applies as it is chosen and writes the copy at once; the line under its row says
// Saved. for a beat, or why it did not save until the next change. Notes is the account's, so it is drawn signed in only.
export function GymSettingsSection() {
  const api = useGymApi();
  const read = useDomainRead(settingsOf);
  const seat = useSyncReplica();
  const signedIn = useSettingsSeat() === 'signed-in';
  const ids = useId();
  // A setting's value as the person chose it, drawn while its write is in flight; then the copy's.
  const [chosen, setChosen] = useState({});
  // Under a setting's row: `saved` for its beat, or the sentence its failed write left.
  const [said, setSaid] = useState({});
  const beats = useRef({});
  const binding = useRef(seat?.binding);
  binding.current = seat?.binding;
  useEffect(() => () => Object.values(beats.current).forEach(clearTimeout), []);
  // Another seat's section starts with nothing chosen and nothing said.
  useEffect(() => { setChosen({}); setSaid({}); }, [seat?.binding]);
  const stored = api?.ready ? read.data : null;
  const units = chosen.units ?? stored?.units;
  useEffect(() => { if (units) spellWeightsIn(units); }, [units]);
  if (!stored) return null;
  const shown = { ...stored, ...chosen };

  // One change, said only on the replica it was made on, whose binding a sign-in or a sign-out meanwhile changes, drawing
  // another seat's section. A refusal says its own sentence; any other failure, the gym's reason. Units draws no Saved. beat.
  const change = async (setting, value, save) => {
    const madeOn = binding.current;
    clearTimeout(beats.current[setting]);
    setChosen((held) => ({ ...held, [setting]: value }));
    setSaid((held) => ({ ...held, [setting]: null }));
    const line = await save().then(() => SAVED, (error) => error?.sentence ?? t('gym.settings.notSaved', { reason: failureReason(error) }));
    setChosen((held) => (held[setting] === value ? without(held, setting) : held));
    if (binding.current !== madeOn) return;
    if (line !== SAVED) {
      setSaid((held) => ({ ...held, [setting]: line }));
      return;
    }
    if (setting === 'units') return;
    setSaid((held) => ({ ...held, [setting]: SAVED }));
    beats.current[setting] = setTimeout(() => setSaid((held) => (held[setting] === SAVED ? { ...held, [setting]: null } : held)), SAVED_FOR_MS);
  };
  const metaOf = (setting, usual) => {
    const line = said[setting];
    if (line === SAVED) return <span style={{ ...look.meta, color: 'var(--color-success)' }} aria-live="polite">{t('gym.settings.saved')}</span>;
    if (line) return <span style={{ ...look.meta, color: 'var(--color-danger)' }} aria-live="polite">{line}</span>;
    return <span style={look.meta} aria-live="polite">{usual}</span>;
  };

  return (
    <Section title={t('gym.settings.title')}>
      <div style={look.unitsRow}>
        <div style={look.head}>
          <span style={styles.primaryText}>{t('gym.settings.units')}</span>
          <span style={look.choices} role="group" aria-label={t('gym.settings.unitsLabel')}>
            {UNITS.map((unit) => (
              <button key={unit} type="button" aria-pressed={unit === shown.units}
                onClick={() => change('units', unit, () => api.savePreferences({ units: unit }))}
                style={unit === shown.units ? { ...look.choice, ...look.choiceOn } : look.choice}>
                {unitSymbol(unit)}
              </button>
            ))}
          </span>
        </div>
        {shown.units === LB && <p style={{ ...styles.calmLine, marginTop: 8 }}>{t('gym.settings.typedInKg')}</p>}
        <p style={said.units ? look.unitsRefused : look.unitsQuiet} aria-live="polite">{said.units ?? ''}</p>
      </div>

      <div style={look.row}>
        <span style={look.main}>
          <span id={`${ids}-rest`} style={styles.primaryText}>{t('gym.settings.restDefault')}</span>
          {metaOf('restSeconds', stored.workout === null ? t('gym.settings.restDefaultMeta')
            : t('gym.settings.restDefaultFollowed', { workout: stored.workout }))}
        </span>
        <Select compact labelledBy={`${ids}-rest`} value={shown.restSeconds === null ? OFF : String(shown.restSeconds)}
          options={restChoices(shown.restSeconds)}
          onChange={(value) => {
            const restSeconds = value === OFF ? null : Number(value);
            change('restSeconds', restSeconds, () => api.saveRestSetting({ restSeconds }));
          }} />
      </div>

      <div style={look.row}>
        <span style={look.main}>
          <span id={`${ids}-sound`} style={styles.primaryText}>{t('gym.settings.restSound')}</span>
          {metaOf('restSound', t('gym.settings.restSoundMeta'))}
        </span>
        <Switch labelledBy={`${ids}-sound`} checked={shown.restSound}
          onChange={(restSound) => change('restSound', restSound, () => api.saveRestSetting({ restSound }))} />
      </div>

      {signedIn && (
        <a href={NOTES_HREF} style={look.row}>
          <span style={look.main}>
            <span style={styles.primaryText}>{NOTES_TITLE}</span>
            <span style={look.meta}>{HEAD_LINE}</span>
          </span>
          <span aria-hidden="true" style={look.chevron}>›</span>
        </a>
      )}
    </Section>
  );
}

export default GymSettingsSection;

// What the section draws from the copy it runs on: the units, the rest settings, and the open workout a new default
// reaches (WD10.6), named as its room names it: one with a movement on Default, which has no rest of its own in the plan or
// is out of it; null while no such workout is open.
function settingsOf(read) {
  const preferences = read.repository(Preferences).find(new Id('prefs', Preferences), 'drawn') ?? new PreferencesValue();
  const rest = restSettings(read);
  const open = new TrainingLog(read).open;
  const rack = open === null ? null : WorkoutRack.of(read, open.id);
  const followsDefault = rack !== null && rack.settled().order.some((movement) => (rack.entry(movement)?.restSeconds ?? null) === null);
  return { units: preferences.units, restSeconds: rest.seconds, restSound: rest.sound,
    workout: followsDefault ? open.name ?? t('gym.workout.untitled') : null };
}

function restChoices(stored) {
  const rests = stored === null || RESTS.includes(stored) ? RESTS : [...RESTS, stored].sort((left, right) => left - right);
  return [{ value: OFF, label: t('gym.settings.restOff') }, ...rests.map((seconds) => ({ value: String(seconds), label: clockOf(seconds * 1000) }))];
}

function without(held, setting) {
  const { [setting]: dropped, ...rest } = held;
  return rest;
}

const look = {
  unitsRow: { padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)', textDecoration: 'none' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  main: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  meta: { ...styles.metaText, marginTop: 0 },
  choices: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  choice: {
    minWidth: 54, padding: '5px 12px',
    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-full)',
    background: 'transparent', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer',
  },
  choiceOn: { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft)' },
  chevron: { fontSize: 18, color: 'var(--text-tertiary)' },
  unitsQuiet: { margin: 0 },
  unitsRefused: { ...styles.metaText, marginTop: 4, color: 'var(--color-danger)' },
};
