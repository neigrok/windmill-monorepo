// The guide at rest on the tree (17.18a, 17.18f, 17.20, 17.24–17.30, 28.29, 28.32): a card on the canvas from 744px, a
// row under the head on phones. It opens the note, and focus returns to it when the note closes.

import React, { useId, useRef } from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, ChevronRight, Plus } from 'lucide-react';
import { track } from '../../../telemetry/beacon.js';
import { GUIDE, guideLabel, guidesFromAbove } from '../copy.js';
import { t } from '../i18n/index.js';
import { OpeningGlyph } from '../OpeningMarks.jsx';
import { guideExcerpt, hasGuide } from './GuideDraft.js';
import { namedAbove } from './GuidesAbove.js';
import { useArrivalFade } from './useGuide.js';
import './guide.css';

// `view` is the view the entry stands on, as its open event says it; the event also says what the entry knew of the
// guides above at the press. Guides from above are said beside the tree's own: on the card's line by their trees, on
// the row by their count. An owner's tree with no guide of its own and none above offers Add guide, which opens the
// note already writing: flushed, so the field takes focus inside the tap that asked.
export function GuideEntry({ guide, band, view }) {
  const phone = band === 'phone';
  const written = hasGuide(guide.text);
  const above = guide.above.length;
  const reads = written || above > 0;
  const title = reads ? (guide.owner ? GUIDE.title : GUIDE.authorsNote) : GUIDE.add;
  const name = written ? guideLabel({ owner: guide.owner, excerpt: guideExcerpt(guide.text) }) : title;
  const Glyph = reads ? BookOpen : Plus;
  const excerpt = useRef(null);
  const aboveId = useId();
  // A title in the card's line stands in a box of its own, which gives way before the line loses its count.
  const named = namedAbove(guide.above);
  const treeTitle = (title) => (title === null ? null : <span className="st-guide-card-tree">{title}</span>);
  useArrivalFade(excerpt, guide.arrival);
  const open = (event) => {
    const keyboard = event.detail === 0;
    track('roadmap_guide', { step: 'open', door: phone ? 'row' : 'card', view, role: guide.owner ? 'owner' : 'reader', above: guide.aboveUnread ? 'unread' : above > 0 ? 'some' : 'none' });
    if (reads) {
      guide.open(null, keyboard);
      return;
    }
    track('roadmap_guide', { step: 'edit', via: 'add' });
    flushSync(() => guide.open({ offset: 0 }, keyboard));
  };

  if (phone) {
    return (
      <button ref={guide.entry} type="button" className="st-guide-row" aria-label={name} aria-describedby={above > 0 ? aboveId : undefined}
        aria-haspopup="dialog" onClick={open}>
        <Glyph size={20} strokeWidth={1.67} aria-hidden />
        <span className="st-guide-row-text">
          <span className="st-guide-row-heading">
            <span className="st-guide-row-title">{title}</span>
            {above > 0 && <span id={aboveId} className="st-guide-row-above">{t('roadmap.guide.aboveCount', { count: above })}</span>}
          </span>
          {written && <span ref={excerpt} className="st-guide-row-excerpt">{guide.text}</span>}
        </span>
        <ChevronRight size={20} strokeWidth={1.67} aria-hidden />
      </button>
    );
  }

  return (
    <button ref={guide.entry} type="button" className={`st-guide-card${guide.opened ? ' is-open' : ''}`} aria-label={name}
      aria-describedby={above > 0 ? aboveId : undefined} aria-haspopup="dialog" aria-expanded={Boolean(guide.opened)} onClick={open}>
      <span className="st-guide-card-heading">
        <span className="st-guide-tab"><Glyph size={24} strokeWidth={1.67} aria-hidden /></span>
        <span className="st-guide-card-title">{title}</span>
        {!reads && <span className="st-guide-card-arrow" aria-hidden>→</span>}
      </span>
      {reads && <>
        {written && <span ref={excerpt} className="st-guide-card-excerpt">{guideExcerpt(guide.text)}</span>}
        {above > 0 && (
          <span id={aboveId} className="st-guide-card-above">
            <OpeningGlyph face="open" size={14} />
            <span>{guidesFromAbove({ first: treeTitle(named.first), second: treeTitle(named.second), more: named.more })}</span>
          </span>
        )}
        <span className="st-guide-rule" />
        <span className="st-guide-card-read">
          <span>{guide.owner ? t('roadmap.guide.read') : t('roadmap.guide.readNote')}</span>
          <span className="st-guide-card-arrow" aria-hidden>→</span>
        </span>
      </>}
    </button>
  );
}
