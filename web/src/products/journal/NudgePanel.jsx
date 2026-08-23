// One switch, the hour the device learned you write, a channel, and a week's pause. Rendered only when
// the engine is armed (JournalApp gates it); a dead mailbox gets the notice below instead of the switch.

import React from 'react';

function hourLabel(ms) {
  const hour = new Date(ms).getHours();
  const period = hour < 12 ? 'am' : 'pm';
  return `${hour % 12 || 12}${period}`;
}

export function NudgePanel({ nudge, onClose }) {
  const { settings, suppressed, enable, disable, setChannel, snooze } = nudge;
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

        {suppressed ? <SuppressedNotice enable={enable} /> : (
          <NudgeControls enabled={enabled} channel={channel} settings={settings}
                         enable={enable} disable={disable} setChannel={setChannel}
                         snooze={snooze} onClose={onClose} />
        )}

        <p className="journal-nudge-foot">
          The rhythm is learned on this device and never leaves it. Only the next moment is sent.
        </p>
      </div>
    </div>
  );
}

// The switch is removed rather than disabled: flipping it would change a stored preference and nothing a
// reader could observe. The flag is cleared only by the owner turning nudges back on, which the server
// reads over a suppressed row as "this address works now"; nothing retries on its own.
function SuppressedNotice({ enable }) {
  return (
    <div className="journal-nudge-suppressed">
      <p className="journal-nudge-when">We can't reach your email address.</p>
      <p className="journal-nudge-note">
        Mail we sent came back permanently undeliverable, or was reported as spam. Either way we
        stopped writing to an address that can't receive it, rather than keep trying.
      </p>
      <p className="journal-nudge-note">
        Sign-in email is unaffected — magic links still go to this address, so you can always get
        back in.
      </p>
      <p className="journal-nudge-note">
        We won't retry on our own. If the address works again, turn nudges back on and we'll write
        to it — and stop again if that mail comes back too.
      </p>
      <button type="button" className="journal-nudge-resume" onClick={() => enable()}>
        Turn nudges back on
      </button>
    </div>
  );
}

function NudgeControls({ enabled, channel, settings, enable, disable, setChannel, snooze, onClose }) {
  return (
    <>
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
    </>
  );
}
