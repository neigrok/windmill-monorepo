// The desktop margin — where a page's ink opens when there is room beside the canvas instead of
// under it. Same ink, same mono margin column, same cut; the 74px day gutter and the 640px measure
// are untouched, and nothing ever stands between the writer and the cursor.
//
// It follows the scroll until a tab is opened, and then it holds that page. Either way it only ever
// states facts: with One two passages and the rest as dates, without One one cut passage and the
// same dates. No head, no count, no buy verb — the ask is the sheet, one tap past the cut.

import React, { useEffect } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';

const MARGIN_INK = 2;   // two passages read; past that the column is a list of dates, not prose

export function EchoMargin({ echoes, page }) {
  const { verify } = echoes;
  const [nearest] = page.matches;
  const read = page.entitled ? page.matches.slice(0, MARGIN_INK) : [nearest];
  const dated = page.matches.slice(read.length);

  // The panel quotes a passage, so the passage has to be found in the live page first — the same
  // guard the tab runs, on whichever page the scroll has brought this panel beside.
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
        />
      ))}
      <InkDates matches={dated} size="desk" onOpen={(match) => echoes.walkTo(page.day, match)} />
      {page.entitled
        ? <p className="je-margin-foot">This panel follows the scroll. It never asks you to do anything.</p>
        : <FreePath match={nearest} />}
    </aside>
  );
}
