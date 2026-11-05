import React, { useId, useRef } from 'react';
import { Button } from '../../../design-system';
import { useComposerFocus } from './composerFocus.js';
import { DISCARD_DRAFT } from '../copy.js';
import './composer.css';

export function DiscardDraft({ phone, onKeep, onDiscard }) {
  const dialog = useRef(null);
  const titleId = useId();
  const focus = useComposerFocus(dialog);
  return (
    <div className="st-board-discard-layer">
      <div className="st-board-composer-scrim" aria-hidden onClick={onKeep} />
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="st-board-discard"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onKeep();
            return;
          }
          focus(event);
        }}
      >
        <h2 id={titleId}>{DISCARD_DRAFT.title}</h2>
        <p>{DISCARD_DRAFT.body}</p>
        <div>
          <Button variant="secondary" size={phone ? 'lg' : 'md'} onClick={onKeep}>{DISCARD_DRAFT.keepEditing}</Button>
          <Button variant="danger" size={phone ? 'lg' : 'md'} onClick={onDiscard}>{DISCARD_DRAFT.discard}</Button>
        </div>
      </section>
    </div>
  );
}
