import React from 'react';
import { CircleAlert, ChevronRight } from 'lucide-react';
import { Button } from '../../../design-system/core/Button.jsx';
import { isCapacityRefusal } from './refusals.js';
import { REFUSED_SYNC, REFUSED_CAPACITY, refusedSyncBody, discardChanges } from '../copy.js';
import './sync-notices.css';

export function RefusedSync({ band, code, count = 1, onRetry, onDiscard }) {
  const phone = band === 'phone';
  const buttonSize = phone ? 'sm' : 'md';
  const capacity = isCapacityRefusal({ code });
  const body = refusedSyncBody({ count });
  const detail = count > 1 ? body : REFUSED_CAPACITY.body;
  return (
    <div className={`board-refused-sync${phone ? ' board-refused-sync--phone' : ''}`} role="alert">
      {!phone && <CircleAlert className="board-refused-sync-icon" size={20} aria-hidden="true" />}
      <p className="board-refused-sync-message">
        <strong>{capacity ? REFUSED_CAPACITY.title : body}</strong>
        {capacity && <span className="board-refused-sync-detail"> {detail}</span>}
      </p>
      <div className="board-refused-sync-actions">
        <Button variant={capacity ? 'secondary' : 'ghost'} size={buttonSize} onClick={onDiscard}>
          {discardChanges({ count })}
        </Button>
        {!capacity && onRetry && (
          <Button variant={phone ? 'primary' : 'secondary'} size={buttonSize} onClick={onRetry}>
            {REFUSED_SYNC.retry}
          </Button>
        )}
      </div>
    </div>
  );
}

export function DeviceLine({ text, onSignIn }) {
  return (
    <button type="button" className="board-device-line" onClick={onSignIn}>
      <span>{text}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}
