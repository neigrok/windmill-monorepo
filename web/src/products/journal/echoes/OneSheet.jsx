// What is actually sold, and the two places it is said.
//
// Not your words — the pass across them. The buy verb is terracotta and the echo is lamp, and they
// never trade places: lamp is memory, terracotta is money. There is one verb, it appears where the
// cut is, and the free path is named beside it — saying "the 14 March page is yours already" costs
// conversions and buys the right to cut at all.

import React, { useState } from 'react';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade } from '../../../shell/billing/checkout.js';
import { distanceAgo, distanceEarlier, proseDayMonth, reachInWords, stampPlain } from './echoDates.js';

// A real A/B switch, not a preference: the price on the verb, or the plan's name. Both are honest;
// only one can be measured at a time.
const PRICE_ON_CTA = true;

const BUY_VERB = PRICE_ON_CTA ? 'See the rest — $12/mo' : 'See the rest with One';

// The offer, wherever the cut is: one sentence, one verb, one decline, and the free path stated.
// Stacked on the desktop margin panel, where 308px is not a row.
export function OfferBlock({ page, nearest, oldest, onBuy, onNotNow, stacked = false }) {
  return (
    <div className={'je-offer' + (stacked ? ' je-offer-stacked' : '')}>
      <p className="je-offer-line">
        You wrote all of it. One is what read across {reachInWords(oldest.day, page.day)} to find it.
      </p>
      <div className="je-offer-buttons">
        <button type="button" className="je-buy" onClick={onBuy}>{BUY_VERB}</button>
        <button type="button" className="je-not-now" onClick={onNotNow}>Not now</button>
      </div>
      <p className="je-free-path">
        The {proseDayMonth(nearest.day)} page is yours already — scroll up to it any time, free.
      </p>
    </div>
  );
}

// A sheet, not a page: the canvas stays behind it and the cursor is never lost. It opens with THEIR
// cut sentence, because that is what they are buying the end of.
export function OneSheet({ page, today, onClose, onNeedSignIn }) {
  const [note, setNote] = useState('');
  const { status } = useAuth();
  const { refresh } = useEntitlements();
  const [nearest] = page.matches;
  const rest = page.matches.length - 1;
  const distance = page.day === today
    ? distanceAgo(nearest.day, page.day)
    : distanceEarlier(nearest.day, page.day);

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

        <div className="je-sheet-cut">
          <div className="je-card-when">
            <span className="je-card-date">{stampPlain(nearest.day)}</span>
            <span className="je-card-distance">{distance}</span>
          </div>
          <p className="je-sheet-passage">
            {nearest.text}
            <span className="je-cut" style={{ width: '30px' }} aria-hidden="true" />
          </p>
          <p className="je-sheet-counts">
            {nearest.withheldWords} MORE WORDS{rest > 0 && ` · ${rest} OTHER ECHOES`}
          </p>
        </div>

        <div className="je-plan">
          <span className="je-plan-name">Windmill One</span>
          <span className="je-plan-price">$12 / month</span>
        </div>

        <ul className="je-bullets">
          <li>Echoes on every page, computed across everything you’ve ever written</li>
          <li>300 tendings a month in Windmill, up from 30</li>
          <li>Everything else in Journal stays free, as it always was</li>
        </ul>

        <div className="je-sheet-buttons">
          <button type="button" className="je-sheet-buy" onClick={buy}>Get One — $12/mo</button>
          <button type="button" className="je-sheet-not-now" onClick={onClose}>Not now</button>
        </div>
        {note && <p className="je-sheet-note">{note}</p>}

        <p className="je-fine">
          Cancel any time, from Settings. Nothing you wrote is ever withdrawn — if One lapses, the
          echoes you already have stay. 30-day money back. Paddle is the seller; USD before tax.
        </p>
      </div>
    </div>
  );
}
