import React from 'react';
import { listMcpKeys } from '../../../shell/auth/McpKeyClient.js';
import { listGrants } from '../../../shell/auth/OAuthClient.js';
import { Back } from '../Back.jsx';
import { COACH_TITLE } from '../coach/coach.js';
import { COACH_HREF } from '../log.js';
import { useGymRead } from '../useGymRead.js';
import {
  APPROVE_WITH_CARE, connectedLabel, connectionsToTheLog, DISCONNECT_LINE, EXCHANGE, FREE_LINE,
  GRANT_LINE, LEVEL_LINES, NEVER, NOTHING_CONNECTED, PERSONAL_KEY_NOTE, PITCH_LINE, PITCH_POINTS,
  PITCH_TITLE, PRECONDITION, WORKBENCH_HREF, WORKBENCH_VERB,
} from './connect.js';

const reachToTheLog = () => Promise.all([listGrants(), listMcpKeys()])
  .then(([grants, keys]) => connectionsToTheLog(grants, keys));

// Reached from the Coach room's door and from the settings row; its two other homes are gone.
export function ConnectLog() {
  const reach = useGymRead(reachToTheLog, []);

  return (
    <section className="gym-connect">
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
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

      <p className="gym-connect-handoff">{GRANT_LINE}</p>
      <a className="gym-connect-door" href={WORKBENCH_HREF}>{WORKBENCH_VERB}</a>
      <p className="gym-connect-disconnect">{DISCONNECT_LINE}</p>
    </section>
  );
}

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
