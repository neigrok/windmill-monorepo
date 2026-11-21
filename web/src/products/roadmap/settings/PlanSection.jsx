// The account's plan as GET /v1/subscription states it, with nothing to buy. No settings page mounts it.

import React from 'react';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { fetchSubscription, holdsWindmillOne } from '../../../shell/billing/subscription.js';
import { t } from '../i18n/settings/index.js';

const PLAN_COPY = {
  windmillOne: { name: t('roadmap.plan.windmillOne'), note: t('roadmap.plan.activeNote') },
  paused: { name: t('roadmap.plan.paused'), note: t('roadmap.plan.pausedNote') },
  ended: { name: t('roadmap.plan.free'), note: t('roadmap.plan.canceledNote') },
  none: { name: t('roadmap.plan.free'), note: t('roadmap.plan.noneNote') },
};

// Windmill One while the account holds it, otherwise what the subscription shown became.
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

  React.useEffect(() => {
    fetchSubscription().then((read) => {
      setSubscription(read);
      setLoading(false);
    });
  }, []);

  const plan = planOf(subscription);
  const copy = PLAN_COPY[plan];
  const ending = plan === 'windmillOne' && subscription.governing?.autoRenew === false ? asDate(subscription.accessUntil) : '';

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
      </div>
    </Section>
  );
}

export default PlanSection;
