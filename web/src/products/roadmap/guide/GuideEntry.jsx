// The guide at rest on the tree (17.18a, 17.18f, 17.20, 17.24–17.30): a card on the canvas from 744px, a row under the
// head on phones. It opens the note, and focus returns to it when the note closes.

import React from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, ChevronRight, Plus } from 'lucide-react';
import { track } from '../../../telemetry/beacon.js';
import { GUIDE, guideLabel } from '../copy.js';
import { t } from '../i18n/index.js';
import { guideExcerpt, hasGuide } from './GuideDraft.js';
import './guide.css';

// `view` is the view the entry stands on, as its open event says it. An owner's tree without a guide offers Add guide,
// which opens the note already writing: flushed, so the field takes focus inside the tap that asked for it.
export function GuideEntry({ guide, band, view }) {
  const phone = band === 'phone';
  const written = hasGuide(guide.text);
  const title = written ? (guide.owner ? GUIDE.title : GUIDE.authorsNote) : GUIDE.add;
  const name = written ? guideLabel({ owner: guide.owner, excerpt: guideExcerpt(guide.text) }) : GUIDE.add;
  const Glyph = written ? BookOpen : Plus;
  const open = () => {
    track('roadmap_guide', { step: 'open', door: phone ? 'row' : 'card', view, role: guide.owner ? 'owner' : 'reader' });
    if (written) {
      guide.open();
      return;
    }
    track('roadmap_guide', { step: 'edit', via: 'add' });
    flushSync(() => guide.open({ offset: 0 }));
  };

  if (phone) {
    return (
      <button ref={guide.entry} type="button" className="st-guide-row" aria-label={name} aria-haspopup="dialog" onClick={open}>
        <Glyph size={20} strokeWidth={1.67} aria-hidden />
        <span className="st-guide-row-text">
          <span className="st-guide-row-title">{title}</span>
          {written && <span key={guide.arrival} className="st-guide-row-excerpt st-switcher-tag">{guide.text}</span>}
        </span>
        <ChevronRight size={20} strokeWidth={1.67} aria-hidden />
      </button>
    );
  }

  const classes = ['st-guide-card'];
  if (!written) classes.push('st-guide-card--add');
  if (guide.opened) classes.push('is-open');
  return (
    <button ref={guide.entry} type="button" className={classes.join(' ')} aria-label={name} aria-haspopup="dialog"
      aria-expanded={Boolean(guide.opened)} onClick={open}>
      <span className="st-guide-card-heading">
        <span className="st-guide-tab"><Glyph size={24} strokeWidth={1.67} aria-hidden /></span>
        <span className="st-guide-card-title">{title}</span>
        {!written && <span className="st-guide-card-arrow" aria-hidden>→</span>}
      </span>
      {written && <>
        <span key={guide.arrival} className="st-guide-card-excerpt st-switcher-tag">{guideExcerpt(guide.text)}</span>
        <span className="st-guide-rule" />
        <span className="st-guide-card-read">
          <span>{guide.owner ? t('roadmap.guide.read') : t('roadmap.guide.readNote')}</span>
          <span className="st-guide-card-arrow" aria-hidden>→</span>
        </span>
      </>}
    </button>
  );
}
