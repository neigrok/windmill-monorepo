// The keyboard-shortcuts reference, rendered from shortcutMap.

import React, { useEffect, useState } from 'react';
import { Dialog } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { SHORTCUTS_TITLE } from '../board/copy.js';
import { visibleGroups, keyLabel, detectPlatform } from './shortcutMap.js';

function Keycap({ children }) {
  return <kbd className="st-keycap">{children}</kbd>;
}

function GesturePill({ children }) {
  return <span className="st-gesture">{children}</span>;
}

export function ShortcutsDialog({ open, onClose, readOnly = false, view = 'graph' }) {
  const [platform, setPlatform] = useState(detectPlatform);
  const board = view === 'board';
  const shownPlatform = board ? detectPlatform() : platform;
  useEffect(() => {
    if (open) track('roadmap_shortcuts_open', { view });
  }, [open, view]);

  return (
    <Dialog open={open} onClose={onClose} title={board ? SHORTCUTS_TITLE : 'Keyboard shortcuts'} width={600} preserveOutsideFocus
      padding={board ? 'calc(var(--space-6) + var(--space-1))' : undefined}>
      {!board && <div className="st-sc-toolbar">
        <div className="st-sc-toggle" role="group" aria-label="Platform">
          <button type="button" aria-pressed={platform === 'mac'} onClick={() => setPlatform('mac')}>Mac</button>
          <button type="button" aria-pressed={platform === 'windows'} onClick={() => setPlatform('windows')}>Windows</button>
        </div>
      </div>}

      <div className={board ? 'st-sc-grid st-sc-grid--board' : 'st-sc-grid'}>
        {visibleGroups(readOnly, view).map((group) => (
          <section className="st-sc-group" key={group.title}>
            <h3 className="st-sc-heading">{group.title}</h3>
            <ul className="st-sc-list">
              {group.rows.map((row) => (
                <li className="st-sc-row" key={row.label}>
                  <span className="st-sc-label">{row.label}</span>
                  <span className="st-sc-keys">
                    {row.chords.map((chord, chordIndex) => (
                      <React.Fragment key={chordIndex}>
                        {chordIndex > 0 && <span className="st-sc-or">or</span>}
                        <span className="st-sc-chord">
                          {chord.map((token, tokenIndex) =>
                            token.kind === 'key'
                              ? <Keycap key={tokenIndex}>{keyLabel(token.label, shownPlatform)}</Keycap>
                              : <GesturePill key={tokenIndex}>{token.label}</GesturePill>
                          )}
                        </span>
                      </React.Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
