// A failed send falls back to the form so the reporter's words are never lost.

import React, { useEffect, useState } from 'react';
import { Dialog, Input, Button } from '../../design-system';
import { sendFeedback, isSendableMessage, MESSAGE_MAX } from './FeedbackClient.js';
import { t } from '../i18n/index.js';

export function FeedbackDialog({ open, onClose }) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState('form'); // form | sending | done
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage('');
    setEmail('');
    setPhase('form');
    setError(null);
    setFocused(false);
  }, [open]);

  const sendable = isSendableMessage(message);

  async function submit() {
    if (!sendable || phase === 'sending') return;
    setPhase('sending');
    setError(null);
    try {
      await sendFeedback({ message, email });
      setPhase('done');
    } catch {
      setPhase('form');
      setError(t('shell.feedback.sendFailed'));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('shell.feedback.title')} width={460}>
      {phase === 'done' ? (
        <div style={column}>
          <p style={thanks}>{t('shell.feedback.thanks')}</p>
          <div style={actions}>
            <Button variant="primary" onClick={onClose}>{t('shell.common.done')}</Button>
          </div>
        </div>
      ) : (
        <div style={column}>
          <p style={lede}>{t('shell.feedback.lede')}</p>

          <div>
            <textarea
              value={message}
              autoFocus
              maxLength={MESSAGE_MAX}
              placeholder={t('shell.feedback.messagePlaceholder')}
              onChange={(e) => { setMessage(e.target.value); if (error) setError(null); }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{ ...textarea, ...(focused ? textareaFocus : null) }}
            />
            {message.length > MESSAGE_MAX - 200 && (
              <div style={counter}>{message.length}/{MESSAGE_MAX}</div>
            )}
          </div>

          <Input
            type="email"
            placeholder={t('shell.feedback.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          {error && <p style={errorLine}>{error}</p>}

          <div style={actions}>
            <Button variant="primary" disabled={!sendable || phase === 'sending'} onClick={submit}>
              {phase === 'sending' ? t('shell.feedback.sending') : t('shell.feedback.send')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default FeedbackDialog;

const column = { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' };

const lede = {
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)',
  color: 'var(--text-secondary)', margin: 0,
};

const textarea = {
  width: '100%',
  minHeight: 132,
  resize: 'vertical',
  padding: '12px 14px',
  boxSizing: 'border-box',
  borderRadius: 'var(--radius-lg)',
  borderWidth: 1.5,
  borderStyle: 'solid',
  borderColor: 'var(--border-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-base)',
  lineHeight: 'var(--leading-sm)',
  outline: 'none',
  transition: 'box-shadow var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
};

const textareaFocus = { borderColor: 'var(--accent-terracotta-400)', boxShadow: 'var(--focus-ring)' };

const counter = {
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
  textAlign: 'right', marginTop: 4,
};

const errorLine = {
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-sm)',
  color: 'var(--color-danger)', margin: 0,
};

const thanks = {
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', lineHeight: 'var(--leading-sm)',
  color: 'var(--text-secondary)', margin: 0,
};

const actions = { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-1)' };
