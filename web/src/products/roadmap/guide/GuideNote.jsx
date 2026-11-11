// The guide open (17.18b–17.19h, 17.21–17.23, 17.26, 17.29, 17.33–17.38): the note in place on the tree from 744px, a
// bottom sheet on phones. It reads until its owner presses the prose or the pencil, then writes in the same frame.

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { BookOpen, Pencil, X } from 'lucide-react';
import { Button } from '../../../design-system';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { track } from '../../../telemetry/beacon.js';
import { DISCARD_DRAFT, GUIDE, LABELS, guideCounter } from '../copy.js';
import { t } from '../i18n/index.js';
import { coverBeneath, useComposerViewport, useCoveredLayer } from '../step/composerFocus.js';
import { GuideDraft, hasGuide } from './GuideDraft.js';
import './guide.css';

// Reading from 744px shares the room: the tree beside the note stays live. Writing, and the phone's sheet in either
// mode, holds the window: everything beneath is inert and a press outside asks to leave. `view` is the view the entry
// stands on, so the note follows its entry when the view changes.
export function GuideNote({ guide, band, view }) {
  const phone = band === 'phone';
  const { owner } = guide;
  const opening = guide.opened.writing;
  // The note stands over its entry, grown 4px to the left and 16px up: measured in the window, and in the room the
  // note shares while it reads.
  const seatOverEntry = () => {
    const entry = guide.entry.current?.getBoundingClientRect();
    const room = guide.entry.current?.closest('.st-root')?.getBoundingClientRect();
    return entry ? { left: entry.left - 4, top: entry.top - 16, roomLeft: room?.left ?? 0, roomTop: room?.top ?? 0 } : null;
  };
  const [draft, setDraft] = useState(() => (opening ? new GuideDraft(guide.text) : null));
  const [caret, setCaret] = useState(() => (opening ? { offset: opening.offset, scroll: 0 } : null));
  const [discarding, setDiscarding] = useState(false);
  const [seat, setSeat] = useState(seatOverEntry);
  const layer = useRef(null);
  const paper = useRef(null);
  const prose = useRef(null);
  const field = useRef(null);
  const confirmation = useRef(null);
  const saving = useRef(false);
  const titleId = useId();
  const countId = useId();
  const discardId = useId();
  const viewport = useComposerViewport(phone);
  const writing = draft !== null;
  const modal = phone || writing;
  const savable = writing && draft.changed && draft.fits;

  // Leaving the draft returns to where writing began: the note read, or the tree for a guide begun from Add guide.
  const leave = () => {
    setDiscarding(false);
    if (!writing || opening) {
      guide.close();
      return;
    }
    setDraft(null);
  };
  const requestLeave = () => {
    if (draft?.changed) {
      setDiscarding(true);
      return;
    }
    leave();
  };

  // Flushed, so the field takes focus inside the press that asked for it and a phone raises its keyboard.
  const begin = (via, offset) => {
    track('roadmap_guide', { step: 'edit', via });
    const hidden = prose.current.scrollHeight - prose.current.clientHeight;
    const scroll = hidden > 0 ? prose.current.scrollTop / hidden : 0;
    flushSync(() => {
      setCaret({ offset, scroll });
      setDraft(new GuideDraft(guide.text));
    });
  };

  const save = async () => {
    if (!savable || saving.current) return;
    saving.current = true;
    const saved = await guide.save(draft);
    saving.current = false;
    if (saved) leave();
  };

  const loadLatest = () => {
    track('roadmap_guide', { step: 'loadLatest' });
    setCaret({ offset: guide.text.length, scroll: 0 });
    setDraft(new GuideDraft(guide.text));
  };

  useLayoutEffect(() => (modal ? coverBeneath(layer.current) : undefined), [modal]);
  useCoveredLayer(paper, discarding);

  useLayoutEffect(() => {
    if (phone) return undefined;
    const place = () => setSeat(seatOverEntry());
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [phone, view]);

  // A guide that holds no words has nothing to read: one cleared here or elsewhere closes the note.
  useEffect(() => {
    if (!writing && !hasGuide(guide.text)) guide.close();
  }, [writing, guide.text]);

  // The field is as tall as its draft, until the note's bound makes it scroll.
  useLayoutEffect(() => {
    const box = field.current;
    if (!box) return undefined;
    const fit = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [draft?.text]);

  // Writing starts where reading stood: the caret where the press landed, the field scrolled as far as the prose was.
  useLayoutEffect(() => {
    const box = field.current;
    if (!caret || !box) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(caret.offset, caret.offset);
    box.scrollTop = caret.scroll * (box.scrollHeight - box.clientHeight);
  }, [caret]);

  useLayoutEffect(() => {
    if (!writing) prose.current?.focus({ preventScroll: true });
  }, [writing]);

  useLayoutEffect(() => {
    if (discarding) confirmation.current.focus({ preventScroll: true });
    else field.current?.focus({ preventScroll: true });
  }, [discarding]);

  // Closing hands focus back to the guide's entry on the tree, unless it already went somewhere else.
  useEffect(() => () => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) guide.entry.current?.focus({ preventScroll: true });
    });
  }, []);

  const title = writing
    ? (hasGuide(draft.base) ? t('roadmap.guide.edit') : GUIDE.add)
    : owner ? GUIDE.title : GUIDE.authorsNote;
  const audience = guide.deviceOnly
    ? t('roadmap.guide.deviceDisclosure')
    : phone ? t('roadmap.guide.disclosurePhone') : t('roadmap.guide.disclosure');
  const paperClasses = ['st-guide-paper'];
  if (phone) paperClasses.push('st-guide-paper--phone');
  if (writing) paperClasses.push('st-guide-paper--writing');

  const seated = !phone && seat !== null;
  const note = (
    <div className={`st-guide-seat${phone ? ' st-guide-seat--phone' : ''}`}
      style={seated ? { left: seat.left - (modal ? 0 : seat.roomLeft), top: seat.top - (modal ? 0 : seat.roomTop) } : undefined}>
      <section ref={paper} className={paperClasses.join(' ')} role="dialog" aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId} tabIndex={-1}
        style={seated ? { maxHeight: `calc(100dvh - ${seat.top + 24}px)` } : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            requestLeave();
            return;
          }
          if (modal) wrapTab(event, paper.current);
        }}>
        {phone && <span className="st-guide-grabber" aria-hidden />}
        <header className="st-guide-heading">
          {!phone && <span className="st-guide-tab"><BookOpen size={24} strokeWidth={1.67} aria-hidden /></span>}
          <div className="st-guide-identity">
            <p>{phone && <BookOpen size={14} strokeWidth={1.67} aria-hidden />}<span>{guide.roadmapTitle}</span></p>
            <h2 id={titleId}>{title}</h2>
          </div>
          {!writing && owner && (
            <button type="button" className="st-guide-pencil" aria-label={t('roadmap.guide.edit')}
              onClick={() => begin('pencil', guide.text.length)}>
              <Pencil size={18} strokeWidth={1.67} aria-hidden />
            </button>
          )}
          {!writing && (
            <button type="button" className="st-guide-close" aria-label={LABELS.close} onClick={guide.close}>
              <X size={18} strokeWidth={1.67} aria-hidden />
            </button>
          )}
        </header>
        {!phone && <span className="st-guide-rule" />}
        {/* The prose holds the note's focus: a reader scrolls it from the keyboard, and its owner writes from it. */}
        {!writing && (
          <p ref={prose} className={`st-guide-prose${owner ? ' st-guide-prose--owner' : ''}`}
            tabIndex={0} role={owner ? undefined : 'region'} aria-labelledby={owner ? undefined : titleId}
            onClick={owner ? (event) => {
              const selected = window.getSelection();
              if (selected && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode)) return;
              // The press's offset in the prose's one text node: caretPositionFromPoint, or Safari's caretRangeFromPoint.
              const point = document.caretPositionFromPoint?.(event.clientX, event.clientY);
              const range = point ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
              const [node, at] = point ? [point.offsetNode, point.offset] : [range?.startContainer, range?.startOffset];
              const landed = node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node);
              begin(phone ? 'tap' : 'click', landed ? at : guide.text.length);
            } : undefined}
            onKeyDown={owner ? (event) => {
              if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              event.preventDefault();
              begin('key', guide.text.length);
            } : undefined}>
            <span key={guide.arrival} className="st-switcher-tag">{guide.text}</span>
          </p>
        )}
        {writing && <>
          <textarea ref={field} rows={1} className={`st-guide-field${draft.fits ? '' : ' st-guide-field--over'}`}
            aria-labelledby={titleId} aria-describedby={countId} value={draft.text}
            placeholder={t('roadmap.guide.placeholder')}
            onChange={(event) => {
              const { value } = event.target;
              setDraft((current) => current.writing(value));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              save();
            }} />
          {/* A status line with its one act stands first; then who reads the guide, the count, and Cancel and Save. */}
          <footer className="st-guide-footer">
            {!phone && draft.outdatedBy(guide.text) && (
              <div className="st-guide-status" role="status">
                <span>{t('roadmap.guide.changedElsewhere')}</span>
                <Button variant="ghost" size="sm" onClick={loadLatest}>{t('roadmap.guide.loadLatest')}</Button>
              </div>
            )}
            {!(phone && draft.counted) && <p className="st-guide-audience">{audience}</p>}
            <p id={countId} className={`st-guide-count${draft.fits ? '' : ' st-guide-count--over'}`} aria-live="polite">
              {draft.counted ? guideCounter(draft) : ''}
            </p>
            <div className="st-guide-actions">
              {phone ? <>
                <button type="button" className="st-guide-cancel" onClick={requestLeave}>{t('roadmap.common.cancel')}</button>
                <button type="button" className="st-guide-save" aria-disabled={savable ? undefined : 'true'}
                  aria-describedby={countId} onClick={save}>{t('roadmap.common.save')}</button>
              </> : <>
                <Button variant="secondary" onClick={requestLeave}>{t('roadmap.common.cancel')}</Button>
                <Button variant={draft.changed ? 'primary' : 'secondary'} held={!savable} describedBy={countId}
                  onClick={save}>{t('roadmap.common.save')}</Button>
              </>}
            </div>
          </footer>
        </>}
      </section>
      {discarding && (
        <div className="st-guide-discard">
          <div className="st-guide-discard-scrim" aria-hidden onClick={() => setDiscarding(false)} />
          <section ref={confirmation} role="alertdialog" aria-modal="true" aria-labelledby={discardId} tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDiscarding(false);
                return;
              }
              wrapTab(event, confirmation.current);
            }}>
            <h2 id={discardId}>{!phone && <BookOpen size={22} strokeWidth={1.67} aria-hidden />}{DISCARD_DRAFT.title}</h2>
            <p>{DISCARD_DRAFT.body}</p>
            <div>
              <Button variant="secondary" size={phone ? 'lg' : 'md'} onClick={() => setDiscarding(false)}>{DISCARD_DRAFT.keepEditing}</Button>
              <Button variant="danger" size={phone ? 'lg' : 'md'} onClick={() => {
                track('roadmap_guide', { step: 'discard' });
                leave();
              }}>{DISCARD_DRAFT.discard}</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );

  if (!modal) return note;
  return createPortal(
    <div ref={layer} className={`st-guide-layer${phone ? ' st-guide-layer--phone' : ''}`} style={viewport.style}>
      <div className="st-guide-backdrop" aria-hidden onClick={requestLeave} />
      {note}
    </div>,
    document.body,
  );
}
