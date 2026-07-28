// The nudge panel: a quiet place to say "knock, so I don't drift" — never a settings sprawl. One
// switch to be nudged, the hour the device learned you write ("around 9pm"), a channel, and a way to
// pause for a week. The line under it tells the truth the engine keeps: the rhythm is worked out on
// this device and never leaves; only the single next moment is sent. The whole panel only exists when
// the engine is armed for this writer (JournalApp gates it), so it never promises a knock it can't send.

import React from 'react';

function hourLabel(ms) {
  const hour = new Date(ms).getHours();
  const period = hour < 12 ? 'am' : 'pm';
  return `${hour % 12 || 12}${period}`;
}

export function NudgePanel({ nudge, onClose }) {
  const { settings, enable, disable, setChannel, snooze } = nudge;
  const enabled = !!settings?.enabled;
  const channel = settings?.channel || 'email';

  return (
    <div
      className="journal-nudge"
      role="dialog"
      aria-label="Nudges"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="journal-nudge-panel">
        <p className="journal-nudge-lead">Nudges</p>

        <button
          type="button"
          className={'journal-nudge-toggle' + (enabled ? ' is-on' : '')}
          role="switch"
          aria-checked={enabled}
          onClick={() => (enabled ? disable() : enable())}
        >
          <span className="journal-nudge-knob" aria-hidden="true" />
          <span className="journal-nudge-toggle-label">
            {enabled ? 'Nudging you to write' : 'Nudge me to write'}
          </span>
        </button>

        {enabled && settings?.nextDueAt && (
          <p className="journal-nudge-when">
            around {hourLabel(settings.nextDueAt)} · the hour you tend to write
          </p>
        )}

        {enabled && (
          <div className="journal-nudge-channel" role="radiogroup" aria-label="How to reach you">
            {['email', 'inapp'].map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={channel === option}
                className={'journal-nudge-chip' + (channel === option ? ' is-on' : '')}
                onClick={() => setChannel(option)}
              >
                {option === 'email' ? 'By email' : 'In the app'}
              </button>
            ))}
          </div>
        )}

        {enabled && (
          <button type="button" className="journal-nudge-snooze" onClick={() => { snooze(); onClose(); }}>
            Pause for a week
          </button>
        )}

        <p className="journal-nudge-foot">
          The rhythm is learned on this device and never leaves it. Only the next moment is sent.
        </p>
      </div>
    </div>
  );
}
