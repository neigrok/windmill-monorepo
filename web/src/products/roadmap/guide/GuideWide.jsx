// The guide from 744px (17.01–17.17): its chip in the identity row and the modal it opens over the whole window.

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Pencil, Plus } from 'lucide-react';
import { Button, Tooltip } from '../../../design-system';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { track } from '../../../telemetry/beacon.js';
import { GUIDE, LABELS, guideCounter, guideLabel } from '../copy.js';
import { t } from '../i18n/index.js';
import { DiscardDraft } from '../step/DiscardDraft.jsx';
import { StepIcons } from '../step/StepIcons.jsx';
import { coverBeneath } from '../step/composerFocus.js';
import { GuideDraft, guideExcerpt, hasGuide } from './GuideDraft.js';
import { focusGuideOpener, useGuideFlash } from './opener.js';
import '../step/modal.css';
import '../step/detail.css';
import './guide.css';

// The tree's identity, not a verb: the first line from 1024px, the book alone with its tooltip below that, and a dashed
// Add guide for an owner whose tree has none.
export function GuideChip({ guide, band }) {
  const [hinted, setHinted] = useState(false);
  const flashing = useGuideFlash(guide.arrival);
  const written = hasGuide(guide.text);
  const excerpt = guideExcerpt(guide.text);
  const folded = band === 'tablet';
  const open = guide.surface?.kind === 'modal';
  const name = written ? guideLabel({ owner: guide.owner, excerpt }) : GUIDE.add;
  const hint = written ? (guide.owner ? GUIDE.title : GUIDE.authorsNote) : GUIDE.add;
  const press = () => {
    track('roadmap_guide', { step: 'open', door: 'row', role: guide.owner ? 'owner' : 'reader' });
    if (written) {
      guide.open('modal');
      return;
    }
    track('roadmap_guide', { step: 'edit', via: 'add' });
    guide.write('modal', { via: 'add', offset: 0 });
  };
  const classes = ['st-roadmap-chip', 'st-guide-chip'];
  if (!written) classes.push('st-guide-chip--add');
  if (folded) classes.push('st-guide-chip--icon');
  if (flashing) classes.push('st-switcher-flash');
  const chip = (
    <button type="button" data-guide-opener className={classes.join(' ')} aria-label={name} aria-haspopup="dialog" aria-expanded={open}
      onClick={press} onMouseEnter={() => setHinted(true)} onMouseLeave={() => setHinted(false)}
      onFocus={() => setHinted(true)} onBlur={() => setHinted(false)}>
      {written ? <BookOpen size={20} strokeWidth={1.67} aria-hidden /> : <Plus size={20} strokeWidth={1.67} aria-hidden />}
      {!folded && <span key={written ? excerpt : 'add'} className="st-guide-chip-text st-switcher-tag">{written ? excerpt : GUIDE.add}</span>}
    </button>
  );
  if (!folded) return chip;
  return <Tooltip label={hint} side="bottom" open={hinted && !open}>{chip}</Tooltip>;
}

// The step modal's anatomy without its size cap, over the whole window and the Shell's head. The owner's text is one
// <textarea> from the start, read-only while reading, so a click that is not a drag-selection writes from where it
// landed; a reader's is plain text.
export function GuideModal({ guide }) {
  const { owner } = guide;
  const opening = guide.surface.writing;
  const [draft, setDraft] = useState(() => (opening ? new GuideDraft(guide.text) : null));
  const [caret, setCaret] = useState(() => (opening ? { offset: opening.offset, scroll: 0 } : null));
  const [discarding, setDiscarding] = useState(false);
  const layer = useRef(null);
  const dialog = useRef(null);
  const body = useRef(null);
  const box = useRef(null);
  const discardLayer = useRef(null);
  const pressedAt = useRef(null);
  const saving = useRef(false);
  const leave = useRef(null);
  const titleId = useId();
  const counterId = useId();

  const requestClose = () => {
    if (draft?.changed) {
      setDiscarding(true);
      return;
    }
    guide.close();
  };
  leave.current = requestClose;

  const begin = (offset) => {
    setCaret({ offset, scroll: body.current?.scrollTop ?? 0 });
    setDraft(new GuideDraft(guide.text));
  };

  const save = async () => {
    if (!draft?.fits || saving.current) return;
    saving.current = true;
    const saved = await guide.save(draft);
    saving.current = false;
    if (saved) guide.close();
  };

  const loadLatest = () => {
    track('roadmap_guide', { step: 'loadLatest' });
    setCaret({ offset: guide.text.length, scroll: 0 });
    setDraft(new GuideDraft(guide.text));
  };

  useLayoutEffect(() => {
    const uncover = coverBeneath(layer.current);
    return () => {
      uncover();
      requestAnimationFrame(focusGuideOpener);
    };
  }, []);

  useLayoutEffect(() => (discarding ? coverBeneath(discardLayer.current) : undefined), [discarding]);

  useEffect(() => {
    if (!opening) dialog.current.focus({ preventScroll: true });
    const escape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.current?.closest('[inert]')) return;
      event.preventDefault();
      event.stopPropagation();
      leave.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);

  // Writing starts where reading stood: the caret where the click landed, the text not moved.
  useLayoutEffect(() => {
    const field = box.current;
    if (!caret || !field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret.offset, caret.offset);
    field.scrollTop = caret.scroll;
    body.current.scrollTop = 0;
  }, [caret]);

  // While reading, the owner's field is as tall as its text and the body scrolls; writing, it fills the body.
  const reading = owner && !draft;
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return undefined;
    if (!reading) {
      field.style.height = '';
      return undefined;
    }
    const fit = () => {
      const style = getComputedStyle(field);
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [reading, guide.text]);

  const fieldClasses = ['st-guide-text', draft ? 'st-guide-text--writing' : 'st-guide-text--reading'];
  if (draft && !draft.fits) fieldClasses.push('st-guide-text--over');

  return createPortal(
    <div ref={layer} className="st-board-step-layer st-guide-layer" onKeyDown={(event) => wrapTab(event, layer.current)}>
      <div className="st-board-step-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
        <div ref={dialog} className="st-board-step-modal st-guide-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className="st-guide-modal-header">
            <BookOpen size={20} strokeWidth={1.67} aria-hidden />
            <div className="st-guide-modal-heading">
              <h2 id={titleId}>{owner ? GUIDE.title : GUIDE.authorsNote}</h2>
              <p>{guide.roadmapTitle}</p>
            </div>
            <button type="button" className="st-board-step-icon-button" aria-label={LABELS.close} onClick={requestClose}>
              <StepIcons.close />
            </button>
          </div>
          <div ref={body} className={`st-guide-modal-body${draft ? ' st-guide-modal-body--writing' : ''}`}>
            {draft?.outdatedBy(guide.text) && (
              <div className="st-guide-strip" role="status">
                <span>{t('roadmap.guide.changedElsewhere')}</span>
                <Button variant="ghost" size="sm" onClick={loadLatest}>{t('roadmap.guide.loadLatest')}</Button>
              </div>
            )}
            {owner ? (
              <textarea
                ref={box}
                rows={1}
                className={fieldClasses.join(' ')}
                aria-labelledby={titleId}
                aria-describedby={draft ? counterId : undefined}
                readOnly={!draft}
                value={draft ? draft.text : guide.text}
                placeholder={GUIDE.placeholder}
                spellCheck={Boolean(draft)}
                onChange={(event) => setDraft((current) => current.writing(event.target.value))}
                onPointerDown={(event) => { pressedAt.current = event.currentTarget.selectionStart; }}
                onClick={(event) => {
                  const field = event.currentTarget;
                  if (draft || field.selectionStart !== field.selectionEnd) return;
                  // Where a browser leaves a read-only field's caret where it was, the point says where the click landed.
                  const moved = field.selectionStart !== pressedAt.current;
                  const point = moved ? null : document.caretPositionFromPoint?.(event.clientX, event.clientY);
                  track('roadmap_guide', { step: 'edit', via: 'click' });
                  begin(point?.offsetNode === field ? point.offset : field.selectionStart);
                }}
                onKeyDown={(event) => {
                  const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
                  if (!draft && event.key === 'Enter' && bare) {
                    event.preventDefault();
                    track('roadmap_guide', { step: 'edit', via: 'key' });
                    begin(guide.text.length);
                    return;
                  }
                  if (draft && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            ) : <p className="st-guide-text st-guide-text--note">{guide.text}</p>}
          </div>
          {owner && (
            <div key={draft ? 'writing' : 'reading'} className="st-guide-modal-footer">
              {draft ? <>
                <span className="st-guide-disclosure">{guide.deviceOnly ? GUIDE.deviceDisclosure : GUIDE.disclosure}</span>
                <span id={counterId} className={`st-guide-counter${draft.fits ? '' : ' st-guide-counter--over'}`} aria-live="polite">
                  {draft.counted ? guideCounter(draft) : ''}
                </span>
                <Button variant="secondary" onClick={requestClose}>{t('roadmap.common.cancel')}</Button>
                <Button held={!draft.fits} describedBy={counterId} onClick={save}>{t('roadmap.common.save')}</Button>
              </> : (
                <span className="st-guide-hint"><Pencil size={20} strokeWidth={1.67} aria-hidden />{t('roadmap.guide.clickToEdit')}</span>
              )}
            </div>
          )}
        </div>
      </div>
      {discarding && createPortal(
        <div ref={discardLayer} className="st-board-composer-layer is-wide">
          <DiscardDraft
            phone={false}
            onKeep={() => setDiscarding(false)}
            onDiscard={() => {
              track('roadmap_guide', { step: 'discard' });
              guide.close();
            }}
          />
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  );
}
