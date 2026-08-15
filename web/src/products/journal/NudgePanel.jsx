// The nudge panel: a quiet place to say "knock, so I don't drift" — never a settings sprawl. One
// switch to be nudged, the hour the device learned you write ("around 9pm"), a channel, and a way to
// pause for a week. The line under it tells the truth the engine keeps: the rhythm is worked out on
// this device and never leaves; only the single next moment is sent. The whole panel only exists when
// the engine is armed for this writer (JournalApp gates it), so it never promises a knock it can't send —
// and when the provider has called the mailbox dead, the switch gives way to saying so, plus the one
// door back: the owner turning nudges on again.

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

// The face a dead mailbox gets, mirrored from roadmap's ReminderSection: the switch is REMOVED, not
// disabled — flipping it would change a stored preference and nothing a reader could observe. The
// copy says "can't reach", never "stopped nudging": the webhook creates the row when it is missing
// and the bounce may have been a magic link, so "stopped" would be a lie told to someone who never
// received a nudge. Sign-in mail is unaffected (nothing in the auth path reads suppressed). What
// clears the flag is the owner turning nudges back on — the button runs the ordinary `enable`, which
// the server reads over a suppressed row as "this address works now" and answers with the fresh
// settings, so the controls return on their own. We never retry by ourselves; being wrong costs one
// more bounce, which suppresses again.
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
