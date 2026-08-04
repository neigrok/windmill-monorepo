// The door to the fixtures: pick a corpus, and the journal opens on it.
//
// Dev only — `journalRoutes` compiles this route out of a production build. Pick a scenario here, or
// jump straight to one with #/journal/echoes-lab?scenario=one and land on the canvas with it loaded.

import React, { useEffect } from 'react';
import { SCENARIOS } from './fixtures.js';
import { serveEchoFixtures } from './devBackend.js';
import '../journal.css';

export function EchoLab({ hash = '' }) {
  const asked = new URLSearchParams(hash.split('?')[1] || '').get('scenario');

  useEffect(() => {
    if (!asked) return;
    serveEchoFixtures(asked);
    window.location.replace('#/journal');
  }, [asked]);

  if (asked) return null;
  return (
    <div className="journal-root" data-theme="dark">
      <div className="journal-scroll">
        <div className="journal-column">
          <h1 className="journal-month">Echo fixtures</h1>
          {SCENARIOS.map((scenario) => (
            <p key={scenario.id} className="journal-prose">
              <a href={`#/journal/echoes-lab?scenario=${scenario.id}`}>{scenario.label}</a>
              <br />
              <span className="journal-gap">{scenario.note}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
