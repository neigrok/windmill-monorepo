// The One sheet — the only surface in Journal that asks for money, and it asks only when there is
// something to buy. Windmill One is not on sale today, so the verb is a line saying so.
//
// A sheet, not a page: the canvas stays behind it and the cursor is never lost. It opens with THEIR
// cut sentence, because that is what they are buying the end of. The canvas itself carries no price,
// plan name, button or badge — the cut is the whole invitation, and an ask the reader opened is not
// an interruption. Lamp is memory and terracotta is money; this is the one screen terracotta is on.
//
// Not your words, either. What is sold is the pass across them — which is why the free path is
// stated one surface earlier, and why nothing written is ever withdrawn if One lapses.

import React, { useState } from 'react';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../../shell/billing/checkout.js';
import { distanceStamp, reachInWords, stampStacked } from './echoDates.js';

// A real A/B switch, not a preference: the price on the verb, or the plan's name. Both are honest;
// only one can be measured at a time. Nothing is being measured today — the verb only renders when
// there is something to buy, and there is not.
const PRICE_ON_CTA = true;

const BUY_VERB = PRICE_ON_CTA ? 'Get One — $12/mo' : 'Get Windmill One';

// Journal's copy of the rule gym's CoachPanel keeps: the verb appears only when there is a door
// behind it. Windmill One is not on sale (shell/billing/checkout.js — paidPlansOpen), so a buy
// button here could only open a checkout nobody can complete. This line stands where it will be.
const ONE_NOT_FOR_SALE = 'Windmill One isn’t on sale yet — nothing here is billable, and the passage stays cut until it is.';

export function OneSheet({ page, onClose, onNeedSignIn, onNotNow }) {
  const [note, setNote] = useState('');
  const { status } = useAuth();
  const { refresh } = useEntitlements();
  const [nearest] = page.matches;
  const oldest = page.matches[page.matches.length - 1];
  const rest = page.matches.length - 1;
  const { head, year } = stampStacked(nearest.day);
  const forSale = paidPlansOpen();

  const buy = async () => {
    if (status !== 'signed-in') { onNeedSignIn?.(); return; }
    const opened = await beginUpgrade({ onCompleted: () => { refresh(); setTimeout(refresh, 2500); onClose(); } });
    if (!opened) setNote('Couldn’t open checkout');
  };

  return (
    <div
      className="je-sheet-scrim"
      role="dialog"
      aria-label="Windmill One"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="je-sheet">
        <span className="je-sheet-grabber" aria-hidden="true" />
        <h2 className="je-sheet-title">The end of that sentence, and every echo after it.</h2>

        <div className="je-ink-row je-ink-sheet">
          <span className="je-ink-margin">
            <span>{head}</span>
            <span>{year}</span>
            <span className="je-ink-distance">{distanceStamp(nearest.day, page.day)}</span>
          </span>
          <span className="je-ink-body">
            <span className="je-ink-passage">{nearest.text}</span>
            <span className="je-ink-withheld">
              {nearest.withheldWords} MORE WORDS{rest > 0 && ` · ${rest} OTHER ECHOES`}
            </span>
          </span>
        </div>

        <p className="je-offer-line">
          You wrote all of it. It was found across {reachInWords(oldest.day, page.day)}; One is what shows it to you whole.
        </p>

        <div className="je-plan">
          <span className="je-plan-name">Windmill One</span>
          <span className="je-plan-price">$12 / month</span>
        </div>

        <ul className="je-bullets">
          <li>Every echo in full — the whole passage, not its opening eight words</li>
          <li>300 tendings a month in your roadmaps, up from 30</li>
          <li>Everything you wrote stays free to read, as it always was</li>
        </ul>

        <div className="je-sheet-buttons">
          {forSale && <button type="button" className="je-sheet-buy" onClick={buy}>{BUY_VERB}</button>}
          <button type="button" className="je-sheet-not-now" onClick={onNotNow}>Not now</button>
        </div>
        {!forSale && <p className="je-sheet-note">{ONE_NOT_FOR_SALE}</p>}
        {note && <p className="je-sheet-note">{note}</p>}

        <p className="je-fine">
          Nothing you wrote is ever withdrawn — if One lapses, your pages and their dates stay, and
          the passages go back to their opening words. 30-day money back when it opens. Paddle is
          the seller; USD before tax.
        </p>
      </div>
    </div>
  );
}
