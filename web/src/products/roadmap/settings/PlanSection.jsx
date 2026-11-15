// Upgrading asks the server for a checkout: the browser never names a price, an email or an account.

import React from 'react';
import { Button } from '../../../design-system';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { beginUpgrade, billingConfigured } from '../../../shell/billing/checkout.js';
import { fetchSubscription, holdsWindmillOne } from '../../../shell/billing/subscription.js';
import { t } from '../i18n/settings/index.js';

const PLAN_COPY = {
  windmillOne: { name: t('roadmap.plan.windmillOne'), note: t('roadmap.plan.activeNote') },
  paused: { name: t('roadmap.plan.paused'), note: t('roadmap.plan.pausedNote') },
  ended: { name: t('roadmap.plan.free'), note: t('roadmap.plan.canceledNote') },
  none: { name: t('roadmap.plan.free'), note: t('roadmap.plan.noneNote') },
};

// Windmill One while the subscription shown holds it, otherwise what that subscription became.
function planOf(subscription) {
  if (holdsWindmillOne(subscription)) return 'windmillOne';
  const state = subscription?.governing?.state;
  if (state === 'paused') return 'paused';
  if (state === 'expired' || state === 'revoked') return 'ended';
  return 'none';
}

const asDate = (ms) => {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};

export function PlanSection() {
  const [subscription, setSubscription] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [opening, setOpening] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setSubscription(await fetchSubscription());
    setLoading(false);
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const upgrade = async () => {
    setFailed(false);
    setOpening(true);
    // The subscription reaches the backend's copy a moment after the payment clears, so re-read rather than guess.
    if (!(await beginUpgrade({ onCompleted: refresh }))) setFailed(true);
    setOpening(false);
  };

  if (!billingConfigured()) return null;

  const plan = planOf(subscription);
  const copy = PLAN_COPY[plan];
  const ending = plan === 'windmillOne' && subscription.governing?.autoRenew === false ? asDate(subscription.accessUntil) : '';
  // This page buys through Paddle, and offers it only while the backend names it purchasable (INV-12).
  const purchasable = Boolean(subscription?.purchasable.includes('paddle'));

  return (
    <Section title={t('roadmap.plan.title')}>
      <div style={styles.row}>
        <div style={styles.rowMain}>
          <div style={styles.primaryText}>{loading ? t('roadmap.plan.checking') : copy.name}</div>
          {!loading && (
            <div style={styles.metaText}>
              {ending ? t('roadmap.plan.ending', { date: ending }) : copy.note}
            </div>
          )}
        </div>
        {!loading && plan === 'windmillOne' && !ending && <span style={styles.tag}>{t('roadmap.plan.activeTag')}</span>}
        {!loading && purchasable && (
          <Button size="sm" onClick={upgrade} disabled={opening}>
            {opening ? t('roadmap.plan.opening') : t('roadmap.plan.upgrade')}
          </Button>
        )}
      </div>
      {failed && (
        <p style={{ ...styles.calmLine, marginTop: 8 }}>
          {t('roadmap.plan.checkoutFailed')}
        </p>
      )}
    </Section>
  );
}

export default PlanSection;
