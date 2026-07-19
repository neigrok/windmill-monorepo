// Settings §Plan: what this account is on, and the one button that changes it.
//
// The state comes from our own database (the Paddle webhook mirrors it there), so this renders
// without touching Paddle. Upgrading asks the server for a checkout — the browser never names a
// price, an email, or an account — and opens it in place.

import React from 'react';
import { Button } from '../../components';
import { Section, styles } from './Section.jsx';
import { beginUpgrade, billingConfigured, fetchSubscription } from '../billing/checkout.js';

const PLAN_COPY = {
  active: { name: 'Windmill Pro', note: 'Thanks for backing the work.' },
  trialing: { name: 'Windmill Pro', note: 'You’re on a trial.' },
  past_due: { name: 'Windmill Pro', note: 'The last payment didn’t go through — Paddle is retrying. Nothing is switched off.' },
  paused: { name: 'Paused', note: 'Billing is paused, so Pro is off for now.' },
  canceled: { name: 'Free', note: 'Your Pro subscription has ended.' },
  none: { name: 'Free', note: 'Everything you need to build, share and fork roadmaps.' },
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
    <Section title="Plan">
      <div style={styles.row}>
        <div style={styles.rowMain}>
          <div style={styles.primaryText}>{loading ? 'Checking…' : copy.name}</div>
          {!loading && (
            <div style={styles.metaText}>
              {ending ? `Pro until ${ending}, then Free.` : copy.note}
            </div>
          )}
        </div>
        {!loading && subscription?.active && !ending && <span style={styles.tag}>ACTIVE</span>}
        {!loading && !subscription?.active && (
          <Button size="sm" onClick={upgrade} disabled={opening}>
            {opening ? 'Opening…' : 'Upgrade'}
          </Button>
        )}
      </div>
      {failed && (
        <p style={{ ...styles.calmLine, marginTop: 8 }}>
          Couldn’t open checkout just now. Try again in a moment.
        </p>
      )}
    </Section>
  );
}

export default PlanSection;
