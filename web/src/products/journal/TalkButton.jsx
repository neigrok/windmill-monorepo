// Talk: speak a page instead of typing it. It is a Windmill One feature, and the paywall is honest
// UP FRONT — the mic never records a non-subscriber's words only to lose them to a 403. A signed-out
// writer is sent to the door; a signed-in writer without Windmill One is sent to checkout, and the
// mic unlocks the moment it completes. Only once entitlement is confirmed does the button record:
// the browser's own recorder captures audio, sends it to the voice endpoint, and drops the transcript
// straight into today — no separate view, no audio kept anywhere (the server transcribes and
// discards). It hides itself when voice isn't available: a browser without a recorder never shows it,
// and a 503 (no vendor wired) retires it for the session. The query for text is the only thing that
// leaves.

import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { journalApi } from './journalApi.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade } from '../../shell/billing/checkout.js';

function pickMime() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export function TalkButton({ onTranscript, onNeedSignIn }) {
  const [phase, setPhase] = useState('idle');   // idle | recording | working | hidden
  const [note, setNote] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const { status } = useAuth();
  const { loading: entLoading, windmillOne, refresh } = useEntitlements();

  // Leaving the page mid-sentence must never leave the mic hot: release the stream on unmount.
  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  if (phase === 'hidden' || typeof window === 'undefined' || !window.MediaRecorder) return null;

  const flash = (message) => { setNote(message); setTimeout(() => setNote(''), 3000); };

  const start = async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flash('No microphone');
      return;
    }
    streamRef.current = stream;
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      setPhase('working');
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      try {
        const text = await journalApi.transcribe(blob, blob.type);
        if (text && text.trim()) onTranscript(text.trim());
        setPhase('idle');
      } catch (error) {
        // The up-front gate makes these the rare races — a session or subscription that lapsed
        // between the check and the send. Re-sync the truth so the mic re-locks rather than lying.
        if (error.status === 403) { setPhase('idle'); refresh(); flash('Talk is part of Windmill One'); }
        else if (error.status === 401) { setPhase('idle'); onNeedSignIn?.(); }
        else setPhase('hidden');   // 503 (no vendor) or worse — voice isn't available; retire it quietly
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('recording');
  };

  const stop = () => recorderRef.current?.stop();

  // The paywall, shown before a single word is spoken. While a signed-in account's entitlement is
  // still loading the mic holds a neutral, disabled face — never a locked flash for a subscriber.
  // Only shown at rest: an entitlement that lapses mid-recording must not yank the stop control out
  // from under a live capture — that case falls through to the recorder below and 403s on send.
  if (phase === 'idle' && (status !== 'signed-in' || !windmillOne)) {
    const checking = status === 'signed-in' && entLoading;
    const openDoor = async () => {
      if (checking) return;
      if (status !== 'signed-in') { onNeedSignIn?.(); return; }
      // The webhook that flips the subscription live can trail checkout.completed by a beat, so
      // re-read once now and once shortly after rather than leaving the mic locked on a paid account.
      const opened = await beginUpgrade({ onCompleted: () => { refresh(); setTimeout(refresh, 2500); } });
      if (!opened) flash('Couldn’t open checkout');
    };
    return (
      <div className="journal-talk">
        <button
          type="button"
          className={'journal-talk-btn ' + (checking ? 'is-checking' : 'is-locked')}
          onClick={openDoor}
          disabled={checking}
          aria-label={checking ? 'Talk' : 'Talk — part of Windmill One'}
          title={checking ? 'Talk' : 'Talk — part of Windmill One'}
        >
          <Mic size={15} strokeWidth={1.9} aria-hidden="true" />
          <span className="journal-talk-label">Talk</span>
          {!checking && <span className="journal-talk-tag">Windmill One</span>}
        </button>
        {note && <span className="journal-talk-note">{note}</span>}
      </div>
    );
  }

  return (
    <div className="journal-talk">
      <button
        type="button"
        className={'journal-talk-btn is-' + phase}
        onClick={() => (phase === 'recording' ? stop() : start())}
        disabled={phase === 'working'}
        aria-label={phase === 'recording' ? 'Stop and transcribe' : 'Talk'}
        title="Talk"
      >
        <Mic size={15} strokeWidth={1.9} aria-hidden="true" />
        <span className="journal-talk-label">
          {phase === 'recording' ? 'Listening · tap to stop' : phase === 'working' ? 'Writing it down…' : 'Talk'}
        </span>
      </button>
      {note && <span className="journal-talk-note">{note}</span>}
    </div>
  );
}
