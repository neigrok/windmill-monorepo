import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, ChevronRight, Plus } from 'lucide-react';
import { track } from '../../../telemetry/beacon.js';
import { Tooltip } from '../../../design-system';
import { GUIDE, guideLabel } from '../copy.js';
import { t } from '../i18n/index.js';
import { guideExcerpt, hasGuide } from './GuideDraft.js';
import { useArrivalFade } from './useGuide.js';
import './guide.css';

export function GuideEntry({ guide, band, view }) {
  const [tooltip, setTooltip] = useState(false);
  const phone = band === 'phone';
  const written = hasGuide(guide.text);
  const above = guide.above.length;
  const unknown = !phone && guide.aboveUnread;
  const reads = written || above > 0 || unknown;
  const title = reads ? (guide.owner ? GUIDE.title : GUIDE.authorsNote) : GUIDE.add;
  const firstLine = guideExcerpt(guide.text);
  const name = written ? guideLabel({ owner: guide.owner, excerpt: firstLine }) : title;
  const Glyph = reads ? BookOpen : Plus;
  const excerpt = useRef(null);
  const aboveId = useId();
  useArrivalFade(excerpt, guide.arrival);
  const seen = useRef(guide.arrival);
  useLayoutEffect(() => {
    if (seen.current === guide.arrival) return;
    seen.current = guide.arrival;
    if (phone || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const entry = guide.entry.current;
    entry?.classList.remove('st-switcher-flash');
    if (entry) void entry.offsetWidth;
    entry?.classList.add('st-switcher-flash');
  }, [guide.arrival, phone]);
  const open = (event) => {
    const keyboard = event.detail === 0;
    track('roadmap_guide', { step: 'open', door: 'row', view, role: guide.owner ? 'owner' : 'reader', above: guide.aboveUnread ? 'unread' : above > 0 ? 'some' : 'none' });
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

  const tooltipLabel = unknown ? t('roadmap.guide.parentUnknownLabel')
    : above > 0 ? t('roadmap.guide.parentsLabel', { label: GUIDE.title, count: above }) : title;
  const tooltipShown = tooltip && !guide.opened;
  const label = unknown ? t('roadmap.guide.parentUnknownLabel')
    : above > 0 ? t('roadmap.guide.parentsLabel', { label: written ? name : GUIDE.title, count: above }) : name;
  const line = unknown ? (written ? t('roadmap.guide.unknownExcerpt', { excerpt: firstLine }) : t('roadmap.guide.unknown'))
    : above > 0 ? (written ? t('roadmap.guide.parentsExcerpt', { count: above, excerpt: firstLine }) : t('roadmap.guide.parentsCount', { count: above }))
    : written ? firstLine : GUIDE.add;
  if (!reads && !guide.owner) return null;
  return (
    <div onMouseEnter={() => setTooltip(true)} onMouseLeave={() => setTooltip(false)}
      onFocus={() => setTooltip(true)} onBlur={() => setTooltip(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !tooltipShown) return;
        event.preventDefault();
        event.stopPropagation();
        setTooltip(false);
      }}
      className={`st-guide-entry-seat${band === 'tablet' ? ' st-guide-entry-seat--compact' : ''}`}>
      <Tooltip label={tooltipLabel} side="bottom" open={tooltipShown}>
        <button ref={guide.entry} type="button" className={`st-guide-entry${reads ? '' : ' st-guide-entry--add'}`}
          aria-label={label} aria-haspopup="dialog" aria-expanded={Boolean(guide.opened)} onClick={open}>
          <Glyph size={20} strokeWidth={2} aria-hidden />
          {band === 'tablet' ? (unknown || above > 0) && (
            <span className="st-guide-entry-count" aria-hidden>{unknown ? '?' : above}</span>
          ) : <span ref={excerpt} className="st-guide-entry-excerpt" aria-hidden>{line}</span>}
        </button>
      </Tooltip>
    </div>
  );
}
