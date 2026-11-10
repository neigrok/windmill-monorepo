// The guide below 744px (17.20–17.30): the reader's line and note, the owner's row and page in the roadmap sheet, and the
// owner's full-screen editor.

import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { BookOpen, ChevronRight, Pencil, Plus } from 'lucide-react';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { track } from '../../../telemetry/beacon.js';
import { Sheet } from '../board/BoardControls.jsx';
import { GUIDE, guideCounter, guideLabel } from '../copy.js';
import { t } from '../i18n/index.js';
import { DiscardDraft } from '../step/DiscardDraft.jsx';
import { coverBeneath, useComposerFocus, useComposerViewport } from '../step/composerFocus.js';
import { GuideDraft, guideExcerpt, hasGuide } from './GuideDraft.js';
import { focusGuideOpener, useGuideFlash } from './opener.js';
import '../step/workspace.css';
import '../step/composer.css';
import '../sync/sync-notices.css';
import './guide.css';

// A reader's note in the device line's slot, which a reader never holds: its first line, a tap from the whole of it.
export function GuideLine({ guide }) {
  const flashing = useGuideFlash(guide.arrival);
  const excerpt = guideExcerpt(guide.text);
  return (
    <button type="button" data-guide-opener className={`board-device-line st-guide-line${flashing ? ' st-switcher-flash' : ''}`}
      aria-label={guideLabel({ owner: false, excerpt })} aria-haspopup="dialog"
      onClick={() => {
        track('roadmap_guide', { step: 'open', door: 'line', role: 'reader' });
        guide.open('note');
      }}>
      <BookOpen size={20} strokeWidth={1.67} aria-hidden />
      <span key={excerpt} className="st-switcher-tag">{excerpt}</span>
      <ChevronRight size={20} strokeWidth={1.67} aria-hidden />
    </button>
  );
}

// The note in a bottom sheet sized to its text, read-only.
export function GuideNote({ guide }) {
  return (
    <Sheet host={document.body} variant="roadmap" title={GUIDE.authorsNote} onClose={() => {
      guide.close();
      focusGuideOpener();
    }}>
      <p className="st-guide-sheet-text">{guide.text}</p>
    </Sheet>
  );
}

// The owner's guide under the roadmap's name in the roadmap sheet: two lines and the way to its page, or Add guide.
export function GuideRow({ guide, rowRef, onOpen }) {
  if (!hasGuide(guide.text)) {
    return (
      <button type="button" className="st-roadmap-sheet-link" onClick={() => {
        track('roadmap_guide', { step: 'open', door: 'sheet', role: 'owner' });
        track('roadmap_guide', { step: 'edit', via: 'add' });
        flushSync(() => guide.write('editor', { via: 'add', offset: 0 }));
      }}>
        <Plus size={20} strokeWidth={1.7} aria-hidden />
        <span>{GUIDE.add}</span>
      </button>
    );
  }
  return (
    <button ref={rowRef} type="button" className="st-roadmap-sheet-link st-guide-row"
      aria-label={guideLabel({ owner: true, excerpt: guideExcerpt(guide.text) })} onClick={() => {
        track('roadmap_guide', { step: 'open', door: 'sheet', role: 'owner' });
        onOpen();
      }}>
      <BookOpen size={20} strokeWidth={1.7} aria-hidden />
      <span className="st-guide-row-text">
        <span className="st-guide-row-label">{GUIDE.title}</span>
        <span className="st-guide-row-excerpt">{guide.text}</span>
      </span>
      <ChevronRight size={20} strokeWidth={1.7} aria-hidden />
    </button>
  );
}

// The Guide page's body inside the roadmap sheet: the text to read, and a tap on it writes from where the finger landed.
export function GuidePage({ guide }) {
  const hintId = useId();
  const write = (via, offset) => flushSync(() => guide.write('editor', { via, offset }));
  return (
    <>
      <p className="st-guide-sheet-text st-guide-page-text" tabIndex={0} aria-describedby={hintId}
        onClick={(event) => {
          const selected = window.getSelection();
          if (selected && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode)) return;
          // The tap's offset in the paragraph's one text node: caretPositionFromPoint, or Safari's caretRangeFromPoint.
          const point = document.caretPositionFromPoint?.(event.clientX, event.clientY);
          const range = point ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
          const [node, at] = point ? [point.offsetNode, point.offset] : [range?.startContainer, range?.startOffset];
          const landed = node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node);
          track('roadmap_guide', { step: 'edit', via: 'tap' });
          write('tap', landed ? at : guide.text.length);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          track('roadmap_guide', { step: 'edit', via: 'key' });
          write('key', guide.text.length);
        }}>
        {guide.text}
      </p>
      <p id={hintId} className="st-guide-hint st-guide-reach"><Pencil size={20} strokeWidth={1.67} aria-hidden />{t('roadmap.guide.tapToEdit')}</p>
    </>
  );
}

// The note editor's full-screen shell around a plain <textarea>, its bar riding the keyboard where the note's
// formatting toolbar would stand.
export function GuideEditor({ guide }) {
  const { offset } = guide.surface.writing;
  const [draft, setDraft] = useState(() => new GuideDraft(guide.text));
  const [discarding, setDiscarding] = useState(false);
  const layer = useRef(null);
  const dialog = useRef(null);
  const box = useRef(null);
  const discardLayer = useRef(null);
  const saving = useRef(false);
  const titleId = useId();
  const counterId = useId();
  const viewport = useComposerViewport(true);
  useComposerFocus(dialog, !discarding, { restore: true });

  useLayoutEffect(() => coverBeneath(layer.current), []);
  useLayoutEffect(() => (discarding ? coverBeneath(discardLayer.current) : undefined), [discarding]);
  useLayoutEffect(() => {
    box.current.focus();
    box.current.setSelectionRange(offset, offset);
  }, []);

  const requestClose = () => {
    if (draft.changed) {
      setDiscarding(true);
      return;
    }
    guide.close();
  };
  const save = async () => {
    if (!draft.fits || saving.current) return;
    saving.current = true;
    const saved = await guide.save(draft);
    saving.current = false;
    if (saved) guide.close();
  };

  return createPortal(
    <div ref={layer} className="st-board-composer-layer is-phone st-guide-editor-layer" style={viewport.style}>
      <div ref={dialog} className="st-board-note-editor st-board-note-editor--phone st-guide-editor" role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
            return;
          }
          wrapTab(event, dialog.current);
        }}>
        <div className="st-board-note-header">
          <button type="button" onClick={requestClose}>{t('roadmap.common.cancel')}</button>
          <div><h3 id={titleId}>{t('roadmap.guide.edit')}</h3><p>{guide.roadmapTitle}</p></div>
        </div>
        <textarea ref={box} className="st-guide-editor-text" aria-labelledby={titleId} aria-describedby={counterId}
          value={draft.text} placeholder={GUIDE.placeholder} onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => current.writing(value));
          }} />
        <div className="st-guide-editor-bar">
          <span id={counterId} aria-live="polite"
            className={draft.counted ? `st-guide-counter${draft.fits ? '' : ' st-guide-counter--over'}` : 'st-guide-disclosure'}>
            {draft.counted ? guideCounter(draft) : guide.deviceOnly ? GUIDE.deviceDisclosure : GUIDE.disclosure}
          </span>
          <button type="button" className="st-board-note-save" aria-disabled={draft.fits ? undefined : 'true'}
            onClick={save}>{t('roadmap.common.save')}</button>
        </div>
      </div>
      {discarding && (
        <div ref={discardLayer} className="st-board-composer-layer is-phone" style={viewport.style}>
          <DiscardDraft
            phone
            onKeep={() => setDiscarding(false)}
            onDiscard={() => {
              track('roadmap_guide', { step: 'discard' });
              guide.close();
            }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
