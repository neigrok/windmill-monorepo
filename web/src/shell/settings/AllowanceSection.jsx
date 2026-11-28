import React, { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../../telemetry/beacon.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { fetchAllowance } from '../billing/allowance.js';
import { t } from '../i18n/settings/index.js';
import { formatMoney, shortDayMonth } from './format.js';
import { Section, styles } from './Section.jsx';

export function AllowanceSection() {
  const { user, account } = useAuth();
  const accountId = user?.id ?? (typeof account === 'string' ? account : account?.id) ?? null;
  const [state, setState] = useState({ status: 'loading', allowance: null, settledFor: undefined });
  const reqRef = useRef(0);

  const load = useCallback(async ({ pending = false } = {}) => {
    const id = ++reqRef.current;
    if (pending) setState({ status: 'loading', allowance: null, settledFor: undefined });
    const result = await fetchAllowance();
    if (id === reqRef.current) setState({ ...result, settledFor: accountId });
  }, [accountId]);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      reqRef.current += 1;
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const loading = state.settledFor !== accountId || state.status === 'loading';
  if (!loading && state.status === 'disabled') return null;

  const retry = () => {
    track('plan_retry', { section: 'allowance' });
    load({ pending: true });
  };

  if (loading) {
    return (
      <Section title={t('shell.allowance.title')}>
        <div className="wm-settings-fade" key="loading">
          <div style={allowanceRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.common.checking')}</div>
            </div>
          </div>
        </div>
      </Section>
    );
  }

  if (state.status === 'error' || !state.allowance) {
    return (
      <Section title={t('shell.allowance.title')}>
        <div className="wm-settings-fade" key="error">
          <div style={allowanceRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.allowance.unavailable')}</div>
            </div>
            <button type="button" className="wm-settings-retry" onClick={retry}>
              {t('shell.common.retry')}
            </button>
          </div>
        </div>
      </Section>
    );
  }

  const { allowance } = state;
  const remaining = Math.max(0, Number(allowance.remaining));
  const limit = Math.max(0, Number(allowance.limit));
  const percent = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  const remainingText = formatMoney(remaining, allowance.currency);
  const limitText = formatMoney(limit, allowance.currency);
  const valueText = t('shell.allowance.leftOf', { remaining: remainingText, limit: limitText });
  const dateText = Number.isSafeInteger(allowance.resetsAtMs) ? shortDayMonth(allowance.resetsAtMs) : '';
  const meta = !dateText
    ? null
    : allowance.period === 'billing_period'
      ? t('shell.allowance.until', { date: dateText })
      : t('shell.allowance.resets', { date: dateText });

  return (
    <Section title={t('shell.allowance.title')}>
      <div className="wm-settings-fade" key="ready" style={meterWrap}>
        <div
          role="meter"
          aria-label={t('shell.allowance.title')}
          aria-valuenow={remaining}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuetext={valueText}
        >
          <div style={styles.primaryText}>{valueText}</div>
          <div className="wm-allowance-track" aria-hidden="true">
            <div className="wm-allowance-fill" style={{ width: `${percent}%` }} />
          </div>
          {meta && <div style={styles.metaText}>{meta}</div>}
        </div>
      </div>
    </Section>
  );
}

export default AllowanceSection;

const allowanceRow = { ...styles.row, minHeight: 52 };
const meterWrap = { padding: '6px 0' };
