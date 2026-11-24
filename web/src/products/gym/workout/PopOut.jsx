import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PictureInPicture2 } from 'lucide-react';
import { Button } from '../../../design-system/index.js';
import { t } from '../i18n/index.js';
import { loadBasisLabel, movementOf } from '../log.js';
import { KG } from '../units.js';

// Pop out (WD2.5): an always-on-top window through Document Picture-in-Picture, offered only where the browser has it.
// It draws what a phone's Lock Screen card does — the movement, which set, the clocks against the static target and one
// Log set — and never what is unsent. Closing it returns to the page as it was. `children` are the workout's clocks.
export function PopOut({ view, name, movementName, catalog, onLog, children }) {
  const [pip, setPip] = useState(null);
  useEffect(() => () => pip?.close(), [pip]);
  if (typeof window === 'undefined' || !('documentPictureInPicture' in window)) return null;

  const open = async () => {
    if (pip) { pip.focus(); return; }
    const opened = await window.documentPictureInPicture.requestWindow({ width: 320, height: 220 });
    for (const sheet of document.styleSheets) {
      try {
        const style = opened.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        opened.document.head.append(style);
      } catch {
        if (!sheet.href) continue;
        const link = opened.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        opened.document.head.append(link);
      }
    }
    opened.document.title = name;
    opened.addEventListener('pagehide', () => setPip(null), { once: true });
    setPip(opened);
  };

  const root = document.querySelector('.gym-root');
  const movement = view.movement;
  const rack = view.rack;
  return (
    <>
      <button type="button" className="gym-live-tool is-pop-out" aria-label={t('gym.workout.popOut')} title={t('gym.workout.popOut')} onClick={open}>
        <PictureInPicture2 size={18} aria-hidden="true" />
      </button>
      {pip && createPortal(
        <div className="gym-root gym-skin gym-live-pip" data-theme={root?.dataset.theme} data-brand="gym">
          {movement && rack ? (
            <>
              <p className="gym-live-pip-head">
                <strong>{movementName(movement.exerciseId)}</strong>
                {movement.targets > 0 && <span>{t('gym.workout.setOf', { position: Math.min(movement.logged + 1, movement.targets), total: movement.targets })}</span>}
              </p>
              {children}
              <p className="gym-live-pip-set">
                <span>{`${rack.weightKg} × ${rack.reps}`}</span>
                <span>{loadBasisLabel(movementOf(catalog, movement.exerciseId), rack.weightKg, KG)}</span>
              </p>
              <Button full held={!view.offer} onClick={onLog}>{t('gym.workout.logSet')}</Button>
            </>
          ) : <p className="gym-quiet">{name}</p>}
        </div>,
        pip.document.body,
      )}
    </>
  );
}
