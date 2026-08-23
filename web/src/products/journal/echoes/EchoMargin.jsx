// The desktop margin — where a page's ink opens when there is room beside the canvas. Above the margin
// breakpoint `.je-ink` is display:none, so this panel is the ink and carries the same two answers.

import React, { useEffect } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';

const MARGIN_INK = 2;   // two passages read; past that the column is a list of dates, not prose

export function EchoMargin({ echoes, page }) {
  const { verify } = echoes;
  const [nearest] = page.matches;
  const read = page.entitled ? page.matches.slice(0, MARGIN_INK) : [nearest];
  const dated = page.matches.slice(read.length);

  // The panel quotes a passage, so it must be located in the live page first — the guard the tab runs.
  useEffect(() => { verify(page.day); }, [verify, page.day]);

  return (
    <aside className="je-margin" aria-label="What you wrote before">
      {read.map((match, index) => (
        <InkRow
          key={match.day}
          match={match}
          triggerDay={page.day}
          size="desk"
          dim={index === 0 ? 1 : 0.78}
          onOpen={() => (page.entitled ? echoes.walkTo(page.day, match) : echoes.openSheet(page.day))}
          onUseful={() => echoes.markUseful(page.day, match.day)}
          onNotUseful={() => echoes.retireMatch(page.day, match.day)}
        />
      ))}
      <InkDates matches={dated} size="desk" onOpen={(match) => echoes.walkTo(page.day, match)} />
      {page.entitled
        ? <p className="je-margin-foot">This panel follows the scroll.</p>
        : <FreePath match={nearest} />}
    </aside>
  );
}
