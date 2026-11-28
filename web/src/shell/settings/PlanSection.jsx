import React, { useEffect, useRef } from 'react';
import { track } from '../../telemetry/beacon.js';
import { useEntitlements } from '../billing/EntitlementsProvider.jsx';
import {
  APPLE_REFUND_URL,
  hasProductionAppStoreRefundLink,
  isRenewalSlack,
  manageUrlFor,
  planTelemetry,
  telemetryStore,
} from '../billing/subscription.js';
import { t } from '../i18n/settings/index.js';
import { formatMoney, shortDayMonth, storeDisplayName } from './format.js';
import { ExternalLink, Section, styles } from './Section.jsx';

function statusTag(environment, state) {
  if (state === 'on_hold') return { label: t('shell.plan.tagOnHold'), style: styles.neutralTag };
  if (state === 'paused') return { label: t('shell.plan.tagPaused'), style: styles.neutralTag };
  if (environment === 'sandbox') return { label: t('shell.plan.tagSandbox'), style: styles.neutralTag };
  return { label: t('shell.plan.tagActive'), style: styles.tag };
}

function singleStatusMeta(governing, now) {
  if (governing.state === 'active') {
    if (governing.autoRenew === false) {
      const ends = governing.currentPeriod?.end ? shortDayMonth(governing.currentPeriod.end) : '';
      return ends ? t('shell.plan.renewalOffEnds', { date: ends }) : t('shell.plan.renewalOff');
    }
    if (isRenewalSlack(governing, now)) {
      const due = governing.nextChargeAt ?? governing.currentPeriod?.end;
      return due ? t('shell.plan.renewalDue', { date: shortDayMonth(due) }) : null;
    }
    const amount = governing.nextCharge ? formatMoney(governing.nextCharge.amount, governing.nextCharge.currency) : '';
    const date = governing.nextChargeAt ? shortDayMonth(governing.nextChargeAt) : '';
    if (amount && date) return t('shell.plan.nextCharge', { amount, date });
    if (date) return t('shell.plan.renewalDue', { date });
    return null;
  }
  if (governing.state === 'grace') {
    const until = governing.graceEndsAt ? shortDayMonth(governing.graceEndsAt) : '';
    return until ? t('shell.plan.paymentRetryingUntil', { date: until }) : t('shell.plan.paymentRetrying');
  }
  if (governing.state === 'on_hold') {
    const failed = governing.paymentFailedAt ? shortDayMonth(governing.paymentFailedAt) : '';
    return failed ? t('shell.plan.paymentFailedOn', { date: failed }) : t('shell.plan.paymentFailed');
  }
  if (governing.state === 'paused') {
    const resumes = governing.resumesAt ? shortDayMonth(governing.resumesAt) : '';
    return resumes ? t('shell.plan.until', { date: resumes }) : null;
  }
  return null;
}

function billedByMeta(entry, includeCharge) {
  const since = entry.startedAt ? shortDayMonth(entry.startedAt) : '';
  if (!includeCharge) return since ? t('shell.plan.since', { date: since }) : null;
  const amount = entry.nextCharge ? formatMoney(entry.nextCharge.amount, entry.nextCharge.currency) : '';
  const date = entry.nextChargeAt ? shortDayMonth(entry.nextChargeAt) : '';
  if (since && amount && date) return t('shell.plan.sinceAndNextCharge', { since, amount, date });
  if (since) return t('shell.plan.since', { date: since });
  if (amount && date) return t('shell.plan.nextChargeShort', { amount, date });
  return null;
}

function BilledByRow({ subscription, entry, includeCharge }) {
  const url = manageUrlFor(subscription, entry);
  const needsPayment = entry.state === 'grace' || entry.state === 'on_hold';
  const reason = needsPayment ? 'update_payment' : 'manage';
  const meta = billedByMeta(entry, includeCharge);
  return (
    <div style={planRow}>
      <div style={styles.rowMain}>
        <div style={styles.primaryText}>{t('shell.plan.billedBy', { store: storeDisplayName(entry.store) })}</div>
        {meta && <div style={styles.metaText}>{meta}</div>}
      </div>
      {url && (
        <ExternalLink
          href={url}
          onClick={() => track('subscription_manage_opened', { store: telemetryStore(entry.store), from: 'plan', reason })}
        >
          {needsPayment ? t('shell.plan.updatePayment') : t('shell.plan.manage')}
        </ExternalLink>
      )}
    </div>
  );
}

function RefundsRow() {
  return (
    <div style={refundsRow}>
      <ExternalLink
        href={APPLE_REFUND_URL}
        onClick={() => track('subscription_refund_help_opened', { store: 'app_store' })}
      >
        {t('shell.plan.refunds')}
      </ExternalLink>
    </div>
  );
}

export function PlanSection() {
  const { subscription = null, subscriptionStatus = 'loading', refresh } = useEntitlements();
  const reportedRef = useRef(null);
  const now = Date.now();
  const telemetry = subscriptionStatus === 'loading' ? null : planTelemetry(subscriptionStatus, subscription, now);
  const telemetryKey = telemetry
    ? `${telemetry.state}|${telemetry.store}|${telemetry.environment}|${telemetry.twice}`
    : null;

  useEffect(() => {
    if (!telemetry || reportedRef.current === telemetryKey) return;
    reportedRef.current = telemetryKey;
    track('plan_viewed', telemetry);
  }, [telemetryKey]);

  const retry = () => {
    track('plan_retry', { section: 'plan' });
    refresh?.({ pending: true });
  };

  if (subscriptionStatus === 'loading') {
    return (
      <Section title={t('shell.plan.title')}>
        <div className="wm-settings-fade" key="loading">
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.common.checking')}</div>
            </div>
          </div>
        </div>
      </Section>
    );
  }

  if (subscriptionStatus === 'error' || !subscription) {
    return (
      <Section title={t('shell.plan.title')}>
        <div className="wm-settings-fade" key="error">
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.plan.unavailable')}</div>
            </div>
            <button type="button" className="wm-settings-retry" onClick={retry}>
              {t('shell.common.retry')}
            </button>
          </div>
        </div>
      </Section>
    );
  }

  const { governing, others = [], environment } = subscription;

  if (!governing) {
    return (
      <Section title={t('shell.plan.title')}>
        <div className="wm-settings-fade" key="free">
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.plan.free')}</div>
            </div>
          </div>
        </div>
      </Section>
    );
  }

  const showRefunds = hasProductionAppStoreRefundLink(subscription);

  if (others.length > 0) {
    const entries = [governing, ...others];
    const tag = statusTag(environment, governing.state);
    return (
      <Section title={t('shell.plan.title')}>
        <div className="wm-settings-fade" key="twice">
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.plan.windmillOne')}</div>
              <div style={styles.metaText}>{t('shell.plan.multipleSubscriptions', { count: entries.length })}</div>
            </div>
            <span style={tag.style}>{tag.label}</span>
          </div>
          {entries.map((entry, index) => (
            <BilledByRow
              key={entry.subscriptionId ?? index}
              subscription={subscription}
              entry={entry}
              includeCharge
            />
          ))}
          {showRefunds && <RefundsRow />}
        </div>
      </Section>
    );
  }

  if (governing.state === 'expired' || governing.state === 'revoked') {
    const endedLabel = governing.state === 'revoked' && governing.endReason === 'refunded'
      ? t('shell.plan.tagRefunded')
      : t('shell.plan.tagEnded');
    const endedAt = governing.endedAt ? shortDayMonth(governing.endedAt) : null;
    return (
      <Section title={t('shell.plan.title')}>
        <div className="wm-settings-fade" key={governing.state}>
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.plan.free')}</div>
            </div>
          </div>
          <div style={planRow}>
            <div style={styles.rowMain}>
              <div style={styles.primaryText}>{t('shell.plan.windmillOne')}</div>
              {endedAt && <div style={styles.metaText}>{endedAt}</div>}
            </div>
            <span style={styles.neutralTag}>{endedLabel}</span>
          </div>
        </div>
      </Section>
    );
  }

  const tag = statusTag(environment, governing.state);
  const meta = singleStatusMeta(governing, now);

  return (
    <Section title={t('shell.plan.title')}>
      <div className="wm-settings-fade" key={`${governing.state}-${environment}`}>
        <div style={planRow}>
          <div style={styles.rowMain}>
            <div style={styles.primaryText}>{t('shell.plan.windmillOne')}</div>
            {meta && <div style={styles.metaText}>{meta}</div>}
          </div>
          <span style={tag.style}>{tag.label}</span>
        </div>
        <BilledByRow subscription={subscription} entry={governing} includeCharge={false} />
        {showRefunds && <RefundsRow />}
      </div>
    </Section>
  );
}

export default PlanSection;

const planRow = { ...styles.row, minHeight: 52 };
const refundsRow = { display: 'flex', alignItems: 'center', paddingTop: 2 };
