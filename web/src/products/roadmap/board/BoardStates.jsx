// The Board's frames besides its columns: the skeleton while a roadmap loads, the load error and the empty roadmap. And
// Roadmap complete, which an empty Up next rests on once every step is done. Measures from 02.09, 02.10, 09.01 and
// 09.11 on the desktop page and 03.03, 03.04 and 03.08 on the phone page.

import React, { createContext } from 'react';
import './states.css';
import { track } from '../../../telemetry/beacon.js';
import { Button } from '../../../design-system';
import { COLUMN_TITLES, EMPTY_ROADMAP, LABELS, LOAD_ERROR, roadmapComplete } from './copy.js';

const COLUMNS = ['locked', 'upNext', 'done'];
const SKELETON_CARDS = { locked: 3, upNext: 2, done: 3 };
const PHONE_SKELETON_CARDS = ['reason', 'plain', 'reason'];

// What the Up next column holds in place of cards: Roadmap complete while every step is done, otherwise nothing.
export const UpNextRest = createContext(null);

export function boardFrame({ tree, loading = false, failed = false }) {
  if (failed) return 'error';
  if (loading || !tree) return 'loading';
  if (tree.nodes.length === 0) return 'empty';
  return 'columns';
}

// A press on a state's action emits which state and which action, then runs it.
function acting(state, action, run) {
  return () => {
    track('roadmap_board_state_action', { state, action });
    run();
  };
}

// The columns' grammar with every count unknown and no spinner: the column titles over cards still to come.
export function BoardSkeleton({ phone }) {
  if (phone) {
    return (
      <div className="st-board-phone" aria-busy="true" tabIndex={-1}>
        <div className="st-board-phone-panes">
          <div className="st-board-phone-pane is-shown">
            <h2 className="st-board-phone-heading">{COLUMN_TITLES.upNext}</h2>
            {PHONE_SKELETON_CARDS.map((size, index) => <SkeletonCard key={index} size={size} />)}
          </div>
        </div>
        <QuietBand />
      </div>
    );
  }
  return (
    <div className="st-board-columns" aria-busy="true" tabIndex={-1}>
      {COLUMNS.map((column) => (
        <section key={column} className={`st-board-columns-column st-board-columns-column--${column}`} tabIndex={-1}>
          <h2 className={`st-board-columns-heading st-board-columns-heading--${column}`}>
            {column === 'upNext' && <span className="st-board-columns-accent" aria-hidden />}
            <span className="st-board-columns-title">{COLUMN_TITLES[column]}</span>
          </h2>
          {Array.from({ length: SKELETON_CARDS[column] }, (_, index) => <SkeletonCard key={index} size="columns" />)}
        </section>
      ))}
    </div>
  );
}

function SkeletonCard({ size }) {
  return (
    <span className={`st-board-skeleton-card st-board-skeleton-card--${size}`} aria-hidden>
      <span className="st-board-skeleton-rail" />
      <span className="st-board-skeleton-lines">
        <span className="st-board-skeleton-line" />
        <span className="st-board-skeleton-line" />
        {size === 'reason' && <span className="st-board-skeleton-line" />}
      </span>
    </span>
  );
}

// The phone's band while there are no columns to pick: the tabs in place, Up next shown, nothing to press or count.
function QuietBand() {
  return (
    <div className="st-board-phone-band st-board-quiet-band" aria-hidden>
      <div className="st-board-phone-segments">
        {COLUMNS.map((column) => (
          <span key={column} className="st-board-phone-segment" aria-selected={column === 'upNext'}>
            <span className="st-board-phone-segment-surface">
              <span className="st-board-phone-segment-label">{COLUMN_TITLES[column]}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function LoadError({ phone, onRetry }) {
  const retry = acting('error', 'retry', onRetry);
  const message = (
    <>
      {phone ? <OfflineIcon /> : <AlertIcon />}
      <h2 className="st-board-state-title">{LOAD_ERROR.title}</h2>
      <p className="st-board-state-body">{LOAD_ERROR.body}</p>
    </>
  );
  if (phone) {
    return (
      <>
        <div className="st-board-state st-board-state--phone" role="alert">
          <div className="st-board-state-message">{message}</div>
          <div className="st-board-state-pinned">
            <Button size="lg" full onClick={retry}>{LOAD_ERROR.action}</Button>
          </div>
        </div>
        <QuietBand />
      </>
    );
  }
  return (
    <div className="st-board-state" role="alert">
      <div className="st-board-state-message">
        {message}
        <Button onClick={retry}>{LOAD_ERROR.action}</Button>
      </div>
    </div>
  );
}

// A roadmap with no steps: no filter, no band, and New step as the one primary. Only the desktop editor can plant a
// first step, so only it draws this frame.
export function EmptyRoadmap({ onNewStep }) {
  return (
    <div className="st-board-state st-board-state--empty">
      <div className="st-board-state-message st-board-state-message--empty">
        <h2 className="st-board-state-title">{EMPTY_ROADMAP.title}</h2>
        <p className="st-board-state-body">{EMPTY_ROADMAP.body}</p>
      </div>
      {onNewStep && <NewStepButton onClick={acting('empty', 'newStep', onNewStep)} />}
    </div>
  );
}

// Said calmly, with no confetti. Only the owner, who can add a step, is invited to; only the owner shares.
export function RoadmapComplete({ phone, total, onShare, onNewStep }) {
  const copy = roadmapComplete({ total });
  const share = onShare ? acting('complete', 'share', onShare) : null;
  const newStep = onNewStep && !phone ? acting('complete', 'newStep', onNewStep) : null;
  return (
    <div className={phone ? 'st-board-complete st-board-complete--phone' : 'st-board-complete'}>
      {phone && <CrownIcon />}
      <h3 className="st-board-complete-title">{copy.title}</h3>
      {onShare && <p className="st-board-state-body">{copy.body}</p>}
      {(share || newStep) && (
        <div className="st-board-complete-actions">
          {share && <Button variant="secondary" onClick={share}>{copy.share}</Button>}
          {newStep && <NewStepButton onClick={newStep} />}
        </div>
      )}
    </div>
  );
}

function NewStepButton({ onClick }) {
  return (
    <button type="button" className="st-board-new-step" onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4.16667 10H15.8333" />
        <path d="M10 4.16667V15.8333" />
      </svg>
      {LABELS.newStep}
    </button>
  );
}

function AlertIcon() {
  return (
    <svg className="st-board-state-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18.3333 10C18.3333 14.6024 14.6024 18.3333 10 18.3333C5.39763 18.3333 1.66667 14.6024 1.66667 10C1.66667 5.39763 5.39763 1.66667 10 1.66667C14.6024 1.66667 18.3333 5.39763 18.3333 10Z" />
      <path d="M10 6.66667V10" />
      <path d="M10 13.3333H10.0083" />
    </svg>
  );
}

function OfflineIcon() {
  return (
    <svg className="st-board-state-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M4.5 4.5L9.3 9.3M9.3 9.3L31.5 31.5M9.3 9.3C6.99891 10.2429 4.87005 11.5608 3 13.2M12.75 24.75C14.152 23.3758 16.0369 22.6061 18 22.6061C19.9631 22.6061 21.848 23.3758 23.25 24.75M7.5 18.9C9.59268 16.9624 12.1943 15.6616 15 15.15M28.5 18.9C27.4322 17.8772 26.2191 17.0179 24.9 16.35M33 13.2C30.7681 11.1986 28.1588 9.66342 25.3253 8.68458C22.4918 7.70574 19.4913 7.303 16.5 7.5" />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg className="st-board-complete-crown" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="3.33333" strokeLinejoin="round" aria-hidden>
      <path d="M6.66667 30H33.3333M8.33333 25L6.66667 11.6667L15 18.3333L20 8.33333L25 18.3333L33.3333 11.6667L31.6667 25H8.33333Z" />
    </svg>
  );
}
