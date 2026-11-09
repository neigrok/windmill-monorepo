// Upgrading asks the server for a checkout: the browser never names a price, an email or an account.

import React from 'react';
import { Button } from '../../../design-system';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { beginUpgrade, billingConfigured, fetchSubscription } from '../../../shell/billing/checkout.js';
import { t } from '../i18n/settings/index.js';

const PLAN_COPY = {
  active: { name: t('roadmap.plan.windmillOne'), note: t('roadmap.plan.activeNote') },
  trialing: { name: t('roadmap.plan.windmillOne'), note: t('roadmap.plan.trialingNote') },
  past_due: { name: t('roadmap.plan.windmillOne'), note: t('roadmap.plan.pastDueNote') },
  paused: { name: t('roadmap.plan.paused'), note: t('roadmap.plan.pausedNote') },
  canceled: { name: t('roadmap.plan.free'), note: t('roadmap.plan.canceledNote') },
  none: { name: t('roadmap.plan.free'), note: t('roadmap.plan.noneNote') },
};

const asDate = (iso) => {
  const at = new Date(iso);
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
    // The webhook lands a moment after the payment clears, so re-read rather than guess the state.
    if (!(await beginUpgrade({ onCompleted: refresh }))) setFailed(true);
    setOpening(false);
  };

  if (!billingConfigured()) return null;

  const status = subscription?.status ?? 'none';
  const copy = PLAN_COPY[status] ?? PLAN_COPY.none;
  const ending = subscription?.scheduledChangeAt ? asDate(subscription.scheduledChangeAt) : '';

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
        {!loading && subscription?.active && !ending && <span style={styles.tag}>{t('roadmap.plan.activeTag')}</span>}
        {!loading && !subscription?.active && (
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
