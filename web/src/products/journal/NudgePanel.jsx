// One switch, the hour the device learned you write, a channel, and a week's pause. Rendered only when
// the engine is armed (JournalApp gates it); a dead mailbox gets the notice below instead of the switch.

import React from 'react';
import { t } from './i18n/index.js';

function hourLabel(ms) {
  const hour = new Date(ms).getHours();
  if (hour < 12) return t('journal.nudge.hourAm', { hour: hour % 12 || 12 });
  return t('journal.nudge.hourPm', { hour: hour % 12 || 12 });
}

export function NudgePanel({ nudge, onClose }) {
  const { settings, suppressed, enable, disable, setChannel, snooze } = nudge;
  const enabled = !!settings?.enabled;
  const channel = settings?.channel || 'email';

  return (
    <div
      className="journal-nudge"
      role="dialog"
      aria-label={t('journal.nudge.title')}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="journal-nudge-panel">
        <p className="journal-nudge-lead">{t('journal.nudge.title')}</p>

        {suppressed ? <SuppressedNotice enable={enable} /> : (
          <NudgeControls enabled={enabled} channel={channel} settings={settings}
                         enable={enable} disable={disable} setChannel={setChannel}
                         snooze={snooze} onClose={onClose} />
        )}

        <p className="journal-nudge-foot">{t('journal.nudge.foot')}</p>
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
      <p className="journal-nudge-when">{t('journal.nudge.unreachable')}</p>
      <p className="journal-nudge-note">{t('journal.nudge.bounced')}</p>
      <p className="journal-nudge-note">{t('journal.nudge.signInUnaffected')}</p>
      <p className="journal-nudge-note">{t('journal.nudge.noRetry')}</p>
      <button type="button" className="journal-nudge-resume" onClick={() => enable()}>
        {t('journal.nudge.resume')}
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
            {enabled ? t('journal.nudge.on') : t('journal.nudge.off')}
          </span>
        </button>

        {enabled && settings?.nextDueAt && (
          <p className="journal-nudge-when">{t('journal.nudge.when', { hour: hourLabel(settings.nextDueAt) })}</p>
        )}

        {enabled && (
          <div className="journal-nudge-channel" role="radiogroup" aria-label={t('journal.nudge.channel')}>
            {['email', 'inapp'].map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={channel === option}
                className={'journal-nudge-chip' + (channel === option ? ' is-on' : '')}
                onClick={() => setChannel(option)}
              >
                {option === 'email' ? t('journal.nudge.byEmail') : t('journal.nudge.inApp')}
              </button>
            ))}
          </div>
        )}

        {enabled && (
          <button type="button" className="journal-nudge-snooze" onClick={() => { snooze(); onClose(); }}>
            {t('journal.nudge.snooze')}
          </button>
        )}
    </>
  );
}
