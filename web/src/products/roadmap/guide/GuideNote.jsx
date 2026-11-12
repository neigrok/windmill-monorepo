// The guide open (17.18–17.19h, 17.21–17.23, 17.26, 17.29, 17.31–17.38, 28.30, 28.31, 28.33): the note in place on the
// tree from 744px, a bottom sheet on phones. It reads until its owner presses the prose or the pencil, then writes in
// the same frame. The guides above the tree stand before its own, farthest first, and are only ever read here.

import React, { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { AlertCircle, BookOpen, Check, ChevronRight, Pencil, Plus, X } from 'lucide-react';
import { Button } from '../../../design-system';
import { focusableElements } from '../../../design-system/feedback/dialogFocus.js';
import { track } from '../../../telemetry/beacon.js';
import { DISCARD_DRAFT, GUIDE, LABELS, guideCounter } from '../copy.js';
import { t } from '../i18n/index.js';
import { OpeningGlyph } from '../OpeningMarks.jsx';
import { TreeDoor } from '../room/useTreeVisit.js';
import { coverBeneath, useComposerViewport, useCoveredLayer } from '../step/composerFocus.js';
import { GuideDraft, hasGuide, withLineFeeds } from './GuideDraft.js';
import { useArrivalFade } from './useGuide.js';
import './guide.css';

// The line that stands in the footer once a save found no door, by the reason the save answered, and after its draft was
// copied: the fact, the way out and the one act that helps. This device's store fails in the server's words, and Done
// returns a copied draft's line to the refusal it answered.
const COULD_NOT_SAVE = { fact: t('roadmap.guide.saveFailed'), wayOut: t('roadmap.guide.saveFailedWayOut'), act: 'retry', label: t('roadmap.common.tryAgain') };
const RECOVERY_LINES = {
  offline: { fact: t('roadmap.guide.saveOffline'), wayOut: t('roadmap.guide.saveOfflineWayOut'), act: 'retry', label: t('roadmap.common.tryAgain') },
  refused: { fact: t('roadmap.guide.saveRefused'), wayOut: t('roadmap.guide.saveRefusedWayOut'), act: 'copy', label: t('roadmap.guide.copyDraft') },
  server: COULD_NOT_SAVE,
  device: COULD_NOT_SAVE,
  copied: { fact: t('roadmap.guide.draftCopied'), wayOut: t('roadmap.guide.draftCopiedNote'), act: 'done', label: t('roadmap.guide.done') },
};

// Reading from 744px shares the room: the tree beside the note stays live. Writing, and the phone's sheet in either
// mode, holds the window: everything beneath is inert and a press outside asks to leave. `view` is the view the entry
// stands on, so the note follows its entry when the view changes; `onSeat` hears the box the note holds on the canvas
// while it reads in place.
export function GuideNote({ guide, band, view, onSeat }) {
  const phone = band === 'phone';
  const { owner, above } = guide;
  const opening = guide.opened.writing;
  const text = withLineFeeds(guide.text);
  const written = hasGuide(guide.text);
  const openTree = useContext(TreeDoor);
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
  const [saving, setSaving] = useState(false);
  // What the footer says instead of who reads the guide: null, or which recovery line stands and its count, so a line
  // said again is a new one to a screen reader.
  const [line, setLine] = useState(null);
  const [ringed, setRinged] = useState(false);
  const [entering, setEntering] = useState(true);
  const [seat, setSeat] = useState(seatOverEntry);
  const layer = useRef(null);
  const paper = useRef(null);
  const stack = useRef(null);
  const prose = useRef(null);
  const add = useRef(null);
  const field = useRef(null);
  const confirmation = useRef(null);
  const stop = useRef(-1);
  const lastPress = useRef(guide.opened.keyboard ? 'key' : 'pointer');
  const enterDown = useRef(false);
  const settled = useRef(false);
  const held = useRef(null);
  const keys = useRef(null);
  const titleId = useId();
  const describerId = useId();
  const discardId = useId();
  const lossId = useId();
  const viewport = useComposerViewport(phone);
  const writing = draft !== null;
  const modal = phone || writing;
  const savable = writing && draft.changed && draft.fits;
  const standing = line && RECOVERY_LINES[line.says];
  const copied = line?.says === 'copied';
  held.current = draft;
  useArrivalFade(prose, guide.arrival);

  // The note dissolves out before it closes; under reduced motion it closes at once.
  const close = () => {
    if (settled.current) return;
    settled.current = true;
    const frame = layer.current ?? paper.current;
    if (!frame || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      guide.close();
      return;
    }
    frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.then(guide.close);
  };

  // Leaving the draft returns to where writing began: the note read, or the tree for a guide begun from Add guide.
  const leave = () => {
    setDiscarding(false);
    setLine(null);
    if (!writing || opening) {
      close();
      return;
    }
    setDraft(null);
  };
  // A save in flight holds the frame: nothing leaves until it settles.
  const requestLeave = () => {
    if (saving) return;
    if (draft?.changed) {
      setDiscarding(true);
      return;
    }
    leave();
  };

  // Flushed, so the field takes focus inside the press that asked for it and a phone raises its keyboard. What scrolls
  // while reading is the prose, or the stack that holds it under the guides from above.
  const begin = (via, offset) => {
    track('roadmap_guide', { step: 'edit', via });
    const scroller = stack.current ?? prose.current;
    const hidden = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    const scroll = hidden > 0 ? scroller.scrollTop / hidden : 0;
    flushSync(() => {
      setCaret({ offset, scroll });
      setDraft(new GuideDraft(guide.text));
    });
  };

  // A save no door took leaves its reason standing as a line; one made while that line offers Try again is the retry.
  // The line moves no focus: it stands under the control the person used, the field after ⌘↩ or the footer's button.
  const save = async () => {
    if (!savable || saving || discarding) return;
    if (standing?.act === 'retry') track('roadmap_guide', { step: 'retry', reason: line.says });
    setSaving(true);
    const reason = await guide.save(draft);
    setSaving(false);
    if (!reason) {
      leave();
      return;
    }
    setLine((before) => ({ says: reason, nth: (before?.nth ?? 0) + 1 }));
  };

  // The whole draft goes to the clipboard. A clipboard that refuses leaves the line as it stood, and a draft edited
  // meanwhile has no line left to change.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.text);
    } catch {
      track('roadmap_guide', { step: 'copy', outcome: 'failed' });
      return;
    }
    track('roadmap_guide', { step: 'copy', outcome: 'copied' });
    setLine((before) => before && { says: 'copied', nth: before.nth + 1 });
  };

  // A save in flight holds the draft it is sending, as it holds the frame.
  const loadLatest = () => {
    if (saving) return;
    track('roadmap_guide', { step: 'loadLatest' });
    setLine(null);
    setCaret({ offset: text.length, scroll: 0 });
    setDraft(new GuideDraft(guide.text));
  };

  // While the note holds the window its keys work wherever focus stands: Escape leaves, ⌘↩ saves, and Tab walks the
  // frame's own stops, which WebKit would otherwise leave for the page.
  keys.current = (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (discarding) setDiscarding(false);
      else requestLeave();
      return;
    }
    // ⌘↩ presses Save or Try again and no other act, and a held key is one press: its repeats neither save again nor
    // press the button focus stands on.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && writing) {
      event.preventDefault();
      if (!event.repeat && (!standing || standing.act === 'retry')) save();
      return;
    }
    if (event.key === 'Enter' && event.repeat && event.target.closest?.('button')) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const frame = discarding ? confirmation.current : paper.current;
    const stops = focusableElements(frame);
    const at = stops.indexOf(document.activeElement);
    const next = at < 0 ? stops.at(event.shiftKey ? -1 : 0) : stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
    (next ?? frame).focus();
  };
  useEffect(() => {
    if (!modal) return undefined;
    const onKey = (event) => keys.current(event);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  // The prose wears its focus ring only when a key brought focus to it.
  useEffect(() => {
    const key = () => { lastPress.current = 'key'; };
    const pointer = () => { lastPress.current = 'pointer'; };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pointer, true);
    };
  }, []);

  useLayoutEffect(() => (modal ? coverBeneath(layer.current) : undefined), [modal]);
  useCoveredLayer(paper, discarding);

  const inPlace = !phone && !modal;
  useLayoutEffect(() => {
    if (!inPlace || !seat || !onSeat) return undefined;
    const publish = () => onSeat({
      left: seat.left - seat.roomLeft, top: seat.top - seat.roomTop, width: paper.current.offsetWidth, height: paper.current.offsetHeight,
    });
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(paper.current);
    return () => {
      observer.disconnect();
      onSeat(null);
    };
  }, [inPlace, seat, onSeat]);

  useLayoutEffect(() => {
    if (phone) return undefined;
    const place = () => setSeat(seatOverEntry());
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [phone, view]);

  // A guide that holds no words under no guide from above has nothing to read: one cleared here or elsewhere closes the note.
  useEffect(() => {
    if (!writing && !written && above.length === 0) guide.close();
  }, [writing, written, above]);

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
    if (!writing) (prose.current ?? add.current)?.focus({ preventScroll: true });
  }, [writing, modal]);

  // Guides from above that arrive or leave while the note reads re-seat this tree's block, which drops the focus it
  // held to the page: the block takes it back.
  useLayoutEffect(() => {
    if (!writing && document.activeElement === document.body) (prose.current ?? add.current)?.focus({ preventScroll: true });
  }, [above]);

  useLayoutEffect(() => {
    if (discarding) confirmation.current.focus({ preventScroll: true });
    else field.current?.focus({ preventScroll: true });
  }, [discarding]);

  // Crossing 744px swaps the footer's buttons for the other band's, which drops the focus one of them held to the page:
  // the stop in the same place takes it.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) focusableElements(paper.current)[stop.current]?.focus({ preventScroll: true });
  }, [phone]);

  // When the field gives up height, to a line that arrives beneath it or a keyboard that rises, the caret's line stays
  // in view. A textarea does not say where its caret is drawn, so a hidden copy of the text before the caret measures it.
  useLayoutEffect(() => {
    const box = field.current;
    if (!box) return undefined;
    let height = box.clientHeight;
    const observer = new ResizeObserver(() => {
      const shrank = box.clientHeight < height;
      height = box.clientHeight;
      if (!shrank || document.activeElement !== box) return;
      const copy = document.createElement('div');
      copy.className = box.className;
      copy.style.cssText = `position: absolute; visibility: hidden; box-sizing: border-box; width: ${box.clientWidth}px; height: auto; min-height: 0; max-height: none; border: 0; white-space: pre-wrap; animation: none;`;
      copy.textContent = `${box.value.slice(0, box.selectionEnd)}\u200b`;
      box.after(copy);
      const foot = copy.offsetHeight;
      copy.remove();
      if (foot > box.scrollTop + box.clientHeight) box.scrollTop = foot - box.clientHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [writing]);

  // Closing hands focus back to the guide's entry on the tree, unless it already went somewhere else. A changed draft
  // the room closed over, because the tree or the route moved on, is a draft discarded.
  useEffect(() => () => {
    if (!settled.current && held.current?.changed) track('roadmap_guide', { step: 'discard' });
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
  if (entering) paperClasses.push('is-entering');
  if (phone) paperClasses.push('st-guide-paper--phone');
  if (writing) paperClasses.push('st-guide-paper--writing');
  // The footer's last button: the standing line's act, else Save, which waits for a change that fits. Done keeps the
  // draft and returns to the refusal it was copied under; leaving it is Cancel's to ask.
  const acts = { retry: save, copy, done: () => setLine((before) => before && { says: 'refused', nth: before.nth + 1 }) };
  const act = standing
    ? { label: standing.label, run: acts[standing.act], waits: false }
    : { label: t('roadmap.common.save'), run: save, waits: !savable };
  // A press leaves focus on the button, which Safari would not: what the press brings, a line or its next act, stands
  // under the control the person used, and a phone's keyboard goes down.
  const press = (event) => {
    if (act.waits) return;
    event.currentTarget.focus({ preventScroll: true });
    act.run();
  };

  // The prose holds the note's focus: a reader scrolls it from the keyboard, and to its owner it is the guide's field at
  // rest, read-only until a press or Enter writes from it.
  const ownGuide = (
    <p ref={prose} className={`st-guide-prose${owner ? ' st-guide-prose--owner' : ''}${ringed ? ' is-ringed' : ''}`}
      tabIndex={0} role={owner ? 'textbox' : 'region'} aria-labelledby={titleId}
      aria-readonly={owner ? 'true' : undefined} aria-multiline={owner ? 'true' : undefined}
      onFocus={() => setRinged(lastPress.current === 'key')}
      onClick={owner ? (event) => {
        const selected = window.getSelection();
        if (selected && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode)) return;
        // The press's offset in the prose's one text node: caretPositionFromPoint, or Safari's caretRangeFromPoint.
        const point = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        const range = point ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
        const [node, at] = point ? [point.offsetNode, point.offset] : [range?.startContainer, range?.startOffset];
        const landed = node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node);
        begin(phone ? 'tap' : 'click', landed ? at : text.length);
      } : undefined}
      onKeyDown={owner ? (event) => {
        if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        if (!event.repeat) begin('key', text.length);
      } : undefined}>
      {text}
    </p>
  );
  // A guide from above is plain text under its tree's name, with no caret and no tint. The name goes into that tree
  // while the note reads; while it writes, leaving the draft is Cancel's to ask, so the name is drawn and does not act.
  const fromAbove = above.map((from) => {
    const name = <>
      <OpeningGlyph face="open" size={14} />
      <span>{from.title}</span>
      <ChevronRight size={14} strokeWidth={1.67} absoluteStrokeWidth aria-hidden />
    </>;
    return (
      <React.Fragment key={from.treeId}>
        <div className="st-guide-from">
          {openTree && !writing
            ? <button type="button" className="st-guide-from-name" onClick={() => openTree(from.treeId, 'guide')}>{name}</button>
            : <p className="st-guide-from-name">{name}</p>}
          <p className="st-guide-from-text">{from.text}</p>
        </div>
        <span className="st-guide-divide" />
      </React.Fragment>
    );
  });
  // This tree's own guide comes last under its name, where the hint says what a press on the prose does and does it.
  const ownName = (
    <p className="st-guide-own">
      <BookOpen size={14} strokeWidth={1.67} absoluteStrokeWidth aria-hidden />
      <span>{t('roadmap.guide.thisTree', { tree: guide.roadmapTitle })}</span>
      {!writing && written && (
        <span className="st-guide-hint" onClick={() => begin(phone ? 'tap' : 'click', text.length)}>
          <Pencil size={14} strokeWidth={1.67} absoluteStrokeWidth aria-hidden />
          {phone ? t('roadmap.guide.tapToEdit') : t('roadmap.guide.clickToEdit')}
        </span>
      )}
    </p>
  );

  const seated = !phone && seat !== null;
  const note = (
    <div className={`st-guide-seat${phone ? ' st-guide-seat--phone' : ''}`}
      style={seated ? { left: seat.left - (modal ? 0 : seat.roomLeft), top: seat.top - (modal ? 0 : seat.roomTop) } : undefined}>
      <section ref={paper} className={paperClasses.join(' ')} role="dialog" aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId} tabIndex={-1}
        style={seated ? { maxHeight: `calc(100dvh - ${seat.top + 24}px)` } : undefined}
        onAnimationEnd={() => setEntering(false)}
        onFocus={(event) => { stop.current = focusableElements(paper.current).indexOf(event.target); }}
        onKeyDown={modal ? undefined : (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          requestLeave();
        }}>
        {phone && <span className="st-guide-grabber" aria-hidden />}
        <header className="st-guide-heading">
          {!phone && <span className="st-guide-tab"><BookOpen size={24} strokeWidth={1.67} aria-hidden /></span>}
          <div className="st-guide-identity">
            <p>{phone && <BookOpen size={14} strokeWidth={1.67} aria-hidden />}<span>{guide.roadmapTitle}</span></p>
            <h2 id={titleId}>{title}</h2>
          </div>
          {!writing && owner && written && (
            <button type="button" className="st-guide-pencil" aria-label={t('roadmap.guide.edit')}
              onClick={() => begin('pencil', text.length)}>
              <Pencil size={18} strokeWidth={1.67} aria-hidden />
            </button>
          )}
          {!writing && (
            <button type="button" className="st-guide-close" aria-label={LABELS.close} onClick={close}>
              <X size={18} strokeWidth={1.67} aria-hidden />
            </button>
          )}
        </header>
        {!phone && <span className="st-guide-rule" />}
        {/* Under guides from above the note reads one stack, which scrolls as the prose does alone; a tree with no guide
            of its own has Add guide as its block. From 744px the guides from above stay over the field while it writes. */}
        {!writing && (above.length > 0 ? (
          <div ref={stack} className="st-guide-stack">
            {fromAbove}
            {ownName}
            {written ? ownGuide : (
              <button ref={add} type="button" className="st-guide-add" onClick={() => begin('add', 0)}>
                <Plus size={18} strokeWidth={1.67} aria-hidden />
                <span>{GUIDE.add}</span>
              </button>
            )}
          </div>
        ) : ownGuide)}
        {writing && !phone && above.length > 0 && (
          <div className="st-guide-context">
            <div className="st-guide-stack">{fromAbove}</div>
            {ownName}
          </div>
        )}
        {writing && <>
          <textarea ref={field} rows={1} className={`st-guide-field${draft.fits ? '' : ' st-guide-field--over'}${standing ? ' st-guide-field--resting' : ''}`}
            aria-labelledby={titleId} aria-describedby={describerId} value={draft.text} readOnly={saving}
            placeholder={t('roadmap.guide.placeholder')}
            onChange={(event) => {
              const { value } = event.target;
              setLine(null);
              setDraft((current) => current.writing(value));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // An Enter still held from the press that opened the note types nothing.
              if (event.repeat && !enterDown.current) event.preventDefault();
              else enterDown.current = true;
            }}
            onKeyUp={(event) => { if (event.key === 'Enter') enterDown.current = false; }} />
          {/* A guide changed elsewhere stands first with its one act. Then who reads the guide and the count, or in
              their place the line a failed save or a copied draft left; then Cancel and that line's act, else Save. */}
          <footer className={`st-guide-footer${standing ? ` st-guide-footer--${copied ? 'copied' : 'failed'}` : ''}`}>
            {draft.outdatedBy(guide.text) && (
              <div className="st-guide-status" role="status">
                {phone ? <>
                  <span><strong>{t('roadmap.guide.changedElsewherePhone')}</strong> <span>{t('roadmap.guide.changedElsewherePhoneNote')}</span></span>
                  <button type="button" className="st-guide-load" onClick={loadLatest}>{t('roadmap.guide.loadLatest')}</button>
                </> : <>
                  <span>{t('roadmap.guide.changedElsewhere')}</span>
                  <Button variant="ghost" size="sm" onClick={loadLatest}>{t('roadmap.guide.loadLatest')}</Button>
                </>}
              </div>
            )}
            <div className="st-guide-closing">
              {standing ? (
                <p key={line.nth} id={describerId} className="st-guide-line" role={copied ? 'status' : 'alert'}>
                  {copied
                    ? <Check size={phone ? 16 : 20} strokeWidth={1.67} absoluteStrokeWidth aria-hidden />
                    : <AlertCircle size={phone ? 16 : 20} strokeWidth={1.67} absoluteStrokeWidth aria-hidden />}
                  <span className="st-guide-line-words"><strong>{standing.fact}</strong> <span>{standing.wayOut}</span></span>
                </p>
              ) : <>
                {!(phone && draft.counted) && <p className="st-guide-audience">{audience}</p>}
                <p id={describerId} className={`st-guide-count${draft.fits ? '' : ' st-guide-count--over'}`} aria-live="polite">
                  {draft.counted ? guideCounter(draft) : ''}
                </p>
              </>}
              <div className="st-guide-actions">
                {phone ? <>
                  <button type="button" className="st-guide-cancel" onClick={requestLeave}>{t('roadmap.common.cancel')}</button>
                  <button type="button" className={`st-guide-save${ringed ? ' is-ringed' : ''}`} aria-disabled={act.waits ? 'true' : undefined}
                    aria-busy={saving ? 'true' : undefined} aria-describedby={describerId}
                    onFocus={() => setRinged(lastPress.current === 'key')} onClick={press}>{act.label}</button>
                </> : <>
                  <Button variant="secondary" onClick={requestLeave}>{t('roadmap.common.cancel')}</Button>
                  <Button variant={draft.changed ? 'primary' : 'secondary'} held={act.waits} ariaBusy={saving} describedBy={describerId}
                    onClick={press}>{act.label}</Button>
                </>}
              </div>
            </div>
          </footer>
        </>}
      </section>
      {discarding && (
        <div className="st-guide-discard">
          <div className="st-guide-discard-scrim" aria-hidden onClick={() => setDiscarding(false)} />
          <section ref={confirmation} role="alertdialog" aria-modal="true" aria-labelledby={discardId}
            aria-describedby={lossId} tabIndex={-1}>
            <h2 id={discardId}>{!phone && <BookOpen size={22} strokeWidth={1.67} aria-hidden />}{DISCARD_DRAFT.title}</h2>
            <p id={lossId}>{DISCARD_DRAFT.body}</p>
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
    <div ref={layer} className={`st-guide-layer${phone ? ' st-guide-layer--phone' : ''}${entering ? ' is-entering' : ''}`} style={viewport.style}>
      {/* A double tap's second click belongs to the press that opened the sheet, so it does not close it. */}
      <div className="st-guide-backdrop" aria-hidden onClick={(event) => { if (event.detail < 2) requestLeave(); }} />
      {note}
    </div>,
    document.body,
  );
}
