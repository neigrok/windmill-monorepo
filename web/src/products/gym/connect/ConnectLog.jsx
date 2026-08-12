// THE CONNECTED LOG — §D screens 12 and 13, as one room and the invitation that walks to it.
//
// TWO SCREENS, ONE ROOM, and the merge is the honest shape rather than a saving. Screen 12 pitches
// the exchange and screen 13 shows the grant; a lifter reading either wants the other in the same
// breath — what does it get, and what has it got already — and two URLs for one decision is how the
// pitch and the state drift apart. So the room reads top to bottom: the trade, the precondition,
// what is connected, what a level buys, what no level buys, and the door.
//
// GYM CONTRIBUTES WORDS AND A LINK. The OAuth consent screen and the revoke are the account's
// (shell/auth/OAuthConsent.jsx, shell/settings/ConnectedToolsSection.jsx) and nothing here rebuilds
// either — this room reads the grants it can see, says what they mean IN GYM'S TERMS, and walks to
// the workbench that holds the URL. A revoke drawn here would be a second door onto one decision,
// which is the same rule that keeps the account's close in the shell alone.
//
// NO LOCK, NO CHIP, NO PRICE, and nothing here leads to a checkout. The reasoning is in connect.js,
// where the copy lives, and it is the whole of W8.

import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { listMcpKeys } from '../../../shell/auth/McpKeyClient.js';
import { listGrants } from '../../../shell/auth/OAuthClient.js';
import { CONNECT_HREF } from '../log.js';
import { useGymRead } from '../useGymRead.js';
import {
  APPROVE_WITH_CARE, connectedLabel, connectionsToTheLog, DISCONNECT_LINE, EXCHANGE, FREE_LINE,
  GRANT_LINE, INVITATION_FREE, INVITATION_KICKER, INVITATION_LINE, INVITATION_VERB, LEVEL_LINES,
  NEVER, NOTHING_CONNECTED, PERSONAL_KEY_NOTE, PITCH_LINE, PITCH_POINTS, PITCH_TITLE, PRECONDITION,
  WORKBENCH_HREF, WORKBENCH_VERB,
} from './connect.js';

// WHAT CAN REACH THIS LOG TAKES BOTH READS OR NEITHER. Two credentials open the door — an approved
// OAuth grant and a static personal key — and the two sentences this surface prints are opposite
// assertions, so a half-answer is not a smaller answer, it is a wrong one. `Promise.all` is what
// makes that structural: either read failing is one failed read, and a failed read draws nothing.
const reachToTheLog = () => Promise.all([listGrants(), listMcpKeys()])
  .then(([grants, keys]) => connectionsToTheLog(grants, keys));

// THE INVITATION, and the two conditions it is ever drawn under — both answered here rather than at
// its call sites, so a third host cannot forget one. It is the same rule AskDoor keeps one file over.
//
//   · NEVER MID-SESSION (§D). A lifter with a bar in their hands is not deciding about MCP, and the
//     hosts already hold the one read that knows — so the fact is passed in rather than re-read.
//     It is answered HERE, above the read, because a card that will draw nothing should not be
//     spending two credentialed requests to find that out on every Routines mount of every workout.
//   · NEVER TO SOMEBODY ALREADY CONNECTED. An invitation to do what you have already done is noise,
//     and noise is what turns an invitation into a nag. A read that has not answered draws NOTHING:
//     silence is an omission, while a card drawn off a half-read would assert that no tool reads
//     this log — which is exactly the thing it could be wrong about.
//
// Nothing counts how often it was walked past (§D3). Declining costs nothing and leaves no trace.
export function ConnectInvitation({ training }) {
  if (training) return null;
  return <InvitationCard />;
}

function InvitationCard() {
  const reach = useGymRead(reachToTheLog, []);
  if (reach.phase !== 'ready' || reach.data.length > 0) return null;
  return (
    <a className="gym-connect-invite" href={CONNECT_HREF}>
      <span className="gym-connect-invite-kicker">{INVITATION_KICKER}</span>
      <span className="gym-connect-invite-line">{INVITATION_LINE}</span>
      <span className="gym-connect-invite-verb">
        {INVITATION_VERB}
        <span className="gym-connect-invite-free">{INVITATION_FREE}</span>
      </span>
    </a>
  );
}

export function ConnectLog() {
  const reach = useGymRead(reachToTheLog, []);

  return (
    <section className="gym-connect">
      <a className="gym-back" href="#/gym">
        <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today
      </a>
      {/* ONE TITLE, AND IT IS THE PITCH'S. The room opened with "Connect your log" over the pitch's
          own headline — two titles stacked, the second the real one. What a lifter arriving here
          from the settings row wants first is what this IS, and the door they came through already
          said its name. */}
      <header className="gym-connect-head">
        <h1 className="gym-connect-title">{PITCH_TITLE}</h1>
        <p className="gym-connect-lede">{PITCH_LINE}</p>
      </header>

      <Exchange />

      <ul className="gym-connect-points">
        {PITCH_POINTS.map((point) => (
          <li className="gym-connect-point" key={point}>{point}</li>
        ))}
      </ul>
      <p className="gym-connect-precondition">{PRECONDITION}</p>
      {/* Where the price was. It is a plain sentence and not a badge, because a badge saying FREE is
          a price tag with a zero on it — the design's own paid chip wearing different ink. */}
      <p className="gym-connect-free">{FREE_LINE}</p>

      <Connections reach={reach} />

      <section className="gym-connect-block">
        <h2 className="gym-connect-block-head">What a connection can do</h2>
        <ul className="gym-connect-levels">
          {Object.entries(LEVEL_LINES).map(([level, line]) => (
            <li className="gym-connect-level" key={level}>
              <span className="gym-connect-level-name">{level}</span>
              <span className="gym-connect-level-line">{line}</span>
            </li>
          ))}
        </ul>
        <p className="gym-connect-care">{APPROVE_WITH_CARE}</p>
      </section>

      <section className="gym-connect-block">
        <h2 className="gym-connect-block-head">What none of them can do</h2>
        <ul className="gym-connect-never">
          {NEVER.map((line) => (
            <li className="gym-connect-never-line" key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {/* The door, and the one fact worth having before you tap it: one URL is the whole of it. */}
      <p className="gym-connect-handoff">{GRANT_LINE}</p>
      <a className="gym-connect-door" href={WORKBENCH_HREF}>{WORKBENCH_VERB}</a>
      <p className="gym-connect-disconnect">{DISCONNECT_LINE}</p>
    </section>
  );
}

// The exchange IS the pitch — one sentence typed on Sunday, one object read on Monday. It is drawn
// as two sides of a trade rather than as a diagram of the protocol, because the protocol is not what
// a lifter is deciding about.
function Exchange() {
  return (
    <div className="gym-connect-exchange">
      <div className="gym-connect-asked">
        <p className="gym-connect-when">{EXCHANGE.askedLabel}</p>
        <p className="gym-connect-said">{EXCHANGE.asked}</p>
      </div>
      <span className="gym-connect-arrow" aria-hidden="true">↓</span>
      <div className="gym-connect-landed">
        <p className="gym-connect-when">{EXCHANGE.landedLabel}</p>
        <p className="gym-connect-said">{EXCHANGE.landed}</p>
      </div>
    </div>
  );
}

// WHAT REACHES THIS LOG, AND NOTHING MORE THAN THAT. A read that has not answered — or one that
// failed — says nothing at all about the state: the two sentences this section can print are
// opposite assertions, and inventing either from an unanswered read is the one mistake that matters
// here. The rest of the room still stands, because it describes the feature rather than this
// account.
//
// A personal key is on this list because it reads this log, and it wears the note that says how far
// past this log it goes. Leaving it off would make the empty sentence a lie on exactly the account
// that most needs it read.
function Connections({ reach }) {
  if (reach.phase !== 'ready') return null;
  const rows = reach.data;
  return (
    <section className="gym-connect-block">
      <h2 className="gym-connect-block-head">What reaches your log</h2>
      {rows.length === 0 && <p className="gym-quiet">{NOTHING_CONNECTED}</p>}
      {rows.length > 0 && (
        <ul className="gym-connect-rows">
          {rows.map((row) => (
            <li className="gym-connect-row" key={row.id}>
              <span className="gym-connect-name">{row.name}</span>
              <span className="gym-connect-state">{connectedLabel(row)}</span>
              {row.personal && <span className="gym-connect-whole">{PERSONAL_KEY_NOTE}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ConnectLog;
