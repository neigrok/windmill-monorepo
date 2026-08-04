// Everything an echo draws inside a page: the mark, the card the mark opens, and — once ever — the
// card that says what an echo is.
//
// The mark is identical for everyone, because hiding it made the canvas dishonest: the journal had
// found something and said nothing. What differs one tap in is how much of the older passage you get.
// With One it is the passage. Without One it stops mid-clause and the withheld words are counted out
// loud — no blur, no lock, no gradient faking text underneath. A blur pretends the words are there
// and unreadable; a stated count is simply true.

import React, { useEffect, useState } from 'react';
import { OfferBlock } from './OneSheet.jsx';
import {
  distanceAgo, distanceEarlier, proseDate, stampLong, stampPlain, stampShort,
} from './echoDates.js';

const DATES_ON_CARD = 4;    // the design lists four, then states the boundary of the rest

export function PageEchoes({ echoes, day }) {
  const [open, setOpen] = useState(false);
  const { verify } = echoes;
  const page = echoes.pageOf(day);
  const first = echoes.firstEchoDay === day;

  useEffect(() => { if (open) verify(day); }, [open, day, verify]);

  if (!page) return null;
  return (
    <div className="je-page">
      <EchoMark count={page.matches.length} onOpen={() => setOpen(true)} />
      {open && <EchoCard echoes={echoes} page={page} onClose={() => setOpen(false)} />}
      {first && <FirstEchoCard echoes={echoes} page={page} />}
    </div>
  );
}

// The mark at rest. Present when the page loads and never arriving — no motion, by rule. The tap row
// is 44px tall; the ink is not.
function EchoMark({ count, onOpen }) {
  return (
    <button type="button" className="je-mark" onClick={onOpen} aria-label={`Echo · ${count} — passages you wrote before`}>
      <span className="je-mark-bar" aria-hidden="true" />
      <span className="je-mark-label">ECHO · {count}</span>
      <svg className="je-mark-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

// One card per page, and one only: the nearest match, in place, with everything else stated as dates.
function EchoCard({ echoes, page, onClose }) {
  const tonight = page.day === echoes.today;
  const [nearest, ...rest] = page.matches;
  const oldest = page.matches[page.matches.length - 1];
  const listed = rest.slice(0, DATES_ON_CARD);
  const beyond = rest.length - listed.length;
  const showOffer = !page.entitled && !echoes.offerRetired(page.day);

  return (
    <div className={'je-card' + (tonight ? '' : ' je-card-walked')}>
      <div className="je-card-position">
        <span className="je-card-bar" aria-hidden="true" />
        <span className="je-card-label">ECHO · 1 OF {page.matches.length}</span>
        <button type="button" className="je-card-close" onClick={onClose} aria-label="Close this echo">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <MatchHeader match={nearest} triggerDay={page.day} tonight={tonight} />
      <Passage match={nearest} entitled={page.entitled} className="je-card-passage" ruleWidth={38} />

      {rest.length > 0 && (
        <>
          <RestLine
            rest={rest.length}
            oldest={oldest}
            onOpenPanel={page.entitled ? () => echoes.openPanel(page.day) : null}
          />
          <div className="je-dates">
            {listed.map((match) => (
              <button
                key={match.day}
                type="button"
                className="je-date-row"
                onClick={() => echoes.walkTo(page.day, match)}
              >
                <span className="je-date-day">{stampPlain(match.day)}</span>
                <span className="je-date-distance">
                  {tonight ? distanceAgo(match.day, page.day) : distanceEarlier(match.day, page.day)}
                </span>
              </button>
            ))}
            {beyond > 0 && (
              <p className="je-date-more">+ {beyond} MORE, TO {stampPlain(oldest.day)}</p>
            )}
          </div>
        </>
      )}

      {showOffer && (
        <OfferBlock
          page={page}
          nearest={nearest}
          oldest={oldest}
          onBuy={() => echoes.openSheet(page.day)}
          onNotNow={() => echoes.retireOffer(page.day)}
        />
      )}
    </div>
  );
}

// Said once, below tonight's page, never during the first run and never with a fanfare. After this
// it is the mark in the margin.
function FirstEchoCard({ echoes, page }) {
  const { verify, claimFirstEcho } = echoes;
  useEffect(() => { verify(page.day); claimFirstEcho(); }, [verify, claimFirstEcho, page.day]);
  const [nearest] = page.matches;
  return (
    <div className="je-first">
      <p className="je-first-lead">Something you wrote before is close to tonight.</p>
      <p className="je-first-note">
        This is the first time that’s happened. It won’t announce itself again — after this it’s the
        mark in the margin.
      </p>
      <div className="je-first-when">
        <span className="je-card-date">{stampShort(nearest.day)}</span>
        <span className="je-card-distance">{distanceAgo(nearest.day, page.day)}</span>
      </div>
      <Passage match={nearest} entitled={page.entitled} className="je-first-passage" ruleWidth={34} />
    </div>
  );
}

// Date and distance, in full, and never withheld — the two facts that make an echo useful when you
// are deciding something. A passage that is not the writer's own says so here: presence is not the
// harm, misattribution is.
function MatchHeader({ match, triggerDay, tonight }) {
  return (
    <div className="je-card-when">
      <span className="je-card-date">{stampLong(match.day)}</span>
      <span className="je-card-distance">
        {tonight ? distanceAgo(match.day, triggerDay) : distanceEarlier(match.day, triggerDay)}
      </span>
      <Attribution match={match} />
    </div>
  );
}

export function Attribution({ match }) {
  if (match.isSelf === false) return <span className="je-attribution">something you copied down</span>;
  if (match.source === 'spoken') return <span className="je-attribution">from your voice note</span>;
  return null;
}

// The passage, at full contrast. Without One it stops where the sweep stopped it, closed by a lamp
// rule and a counted remainder.
export function Passage({ match, entitled, className, ruleWidth }) {
  const withheld = entitled ? 0 : (match.withheldWords || 0);
  return (
    <>
      <p className={className}>
        {match.text}
        {withheld > 0 && <span className="je-cut" style={{ width: `${ruleWidth}px` }} aria-hidden="true" />}
      </p>
      {withheld > 0 && <p className="je-withheld">{withheld} MORE WORDS</p>}
    </>
  );
}

// How many others there are and how far back they run. With One it is the door to all of them; without
// it, it is a true sentence about pages you already own.
function RestLine({ rest, oldest, onOpenPanel }) {
  const words = (
    <>
      <strong>{rest} more</strong>, back to {proseDate(oldest.day)}
    </>
  );
  if (!onOpenPanel) return <p className="je-rest">{words}</p>;
  return (
    <button type="button" className="je-rest je-rest-door" onClick={onOpenPanel}>{words}</button>
  );
}
