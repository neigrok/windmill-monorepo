import React from 'react';
import { NOTES_HREF, THREADS_HREF } from '../log.js';

export function CoachNavigation({ active = null, noteCount = null, narrow = false }) {
  return <>
    {narrow && <nav className="gym-coach-shortcuts" aria-label="Coach tools"><a href={NOTES_HREF}>Notes</a><a href={THREADS_HREF}>Threads</a><a href="/app/connect">Connect tools</a></nav>}
    <aside className="gym-coach-side">
    <a href={NOTES_HREF} aria-current={active === 'notes' ? 'page' : undefined}>Notes<span>{noteCount == null ? 'What you write for Coach' : `${noteCount} for Coach`}</span></a>
    <a href={THREADS_HREF}>Threads<span>Your conversations</span></a>
    <div className="gym-coach-connect"><strong>Connect your tools to read your training log</strong><p>Read only, and only your gym log, until you grant more.</p><a href="/app/connect">Connect tools ›</a></div>
    </aside>
  </>;
}
