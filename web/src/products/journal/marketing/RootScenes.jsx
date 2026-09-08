// The journal's two scenes on the brand root: the hero band's glimpse and the section's illustration.
// Both are still — the root's one infinite motion belongs to the roadmap's crown — and both stand on
// whatever ground the root paints the journal band with, so every colour is a token of that ground.
// Each is a figure holding one hidden stage and one caption: the composed page is decoration a screen
// reader is spared, and the caption outside the stage is what it is told instead, so a made-up diary
// entry is never announced as the site's own words.

import React from 'react';
import './journalRootScenes.css';

function PageCard({ stamp, quiet, children }) {
  return (
    <div className="jn-root-card">
      <div className="jn-root-head">
        <span className="jn-root-dot" />
        <b>{stamp}</b>
      </div>
      <p className="jn-root-quiet">{quiet}</p>
      <hr className="jn-root-rule" />
      <p className="jn-root-page">{children}</p>
    </div>
  );
}

export function JournalGlimpse() {
  return (
    <figure className="jn-root-scene">
      <div className="jn-root-stage" aria-hidden="true">
        <PageCard stamp="Tonight" quiet="Yesterday — walked before work. Slept better than the week before.">
          Finished the chapter I kept avoiding. Lighter than expected
          <span className="jn-root-caret" />
        </PageCard>
      </div>
      <figcaption className="composed">Composed page</figcaption>
    </figure>
  );
}

export function JournalIllustration() {
  return (
    <figure className="jn-root-scene">
      <div className="jn-root-search" aria-hidden="true">
        <div className="jn-root-field">
          <span className="jn-root-glass">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" focusable="false">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </span>
          <span className="jn-root-query">the night I felt lighter</span>
          <kbd className="jn-root-key">⌘K</kbd>
        </div>
        <div className="jn-root-echo">
          <span className="jn-root-dot" />
          <b>Found by meaning · 14 March</b>
          <span className="jn-root-echo-hit">“…lighter than expected.”</span>
        </div>
        <PageCard stamp="14 March" quiet="Yesterday — walked before work, skipped the second coffee.">
          Finished the chapter I kept avoiding. It was shorter than the dread of it. Lighter than expected, and I want to remember that the next time something sits unread for a month.
        </PageCard>
      </div>
      <figcaption className="composed">Composed page</figcaption>
    </figure>
  );
}
