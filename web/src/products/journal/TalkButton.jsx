// Talk: speak a page instead of typing it. Entitlement is checked before the mic opens, so no recording
// is lost to a 403. Audio goes to the voice endpoint and the transcript drops into today; no audio is
// kept. A browser without MediaRecorder never shows it, and a 503 retires it for the session.

import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { journalApi } from './journalApi.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../shell/billing/checkout.js';

const DISCARD_PROMISE = 'The recording is transcribed and thrown away. No audio is kept anywhere.';

function pickMime() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export function TalkButton({ onTranscript, onNeedSignIn }) {
  // `starting` is a phase of its own: without it a second press opens a second recorder over the first,
  // and the first stream is then released by nothing.
  const [phase, setPhase] = useState('idle');   // idle | starting | recording | working | hidden
  const [open, setOpen] = useState(false);      // the sheet
  const [note, setNote] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const { status } = useAuth();
  const { loading: entLoading, windmillOne, refresh } = useEntitlements();

  // Release the stream on unmount: leaving the page mid-sentence must never leave the mic hot.
  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  // Escape closes the sheet, and closing it stops a recording — the same as pressing the tool again.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || phase === 'starting') return;
      if (phase === 'recording') recorderRef.current?.stop();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase]);

  if (phase === 'hidden' || typeof window === 'undefined' || !window.MediaRecorder) return null;

  const entitled = status === 'signed-in' && windmillOne;
  const checking = status === 'signed-in' && entLoading;
  const flash = (message) => { setNote(message); setTimeout(() => setNote(''), 3000); };

  const start = async () => {
    setPhase('starting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase('idle');
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
        setOpen(false);
      } catch (error) {
        // A session or subscription that lapsed between the check and the send: re-sync so the mic re-locks.
        if (error.status === 403) { setPhase('idle'); refresh(); flash('Talk is part of Windmill One'); }
        else if (error.status === 401) { setPhase('idle'); setOpen(false); onNeedSignIn?.(); }
        else { setPhase('hidden'); setOpen(false); }   // 503 (no vendor) or worse — retire it quietly
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('recording');
  };

  const stop = () => recorderRef.current?.stop();

  const press = () => {
    if (checking || phase === 'starting') return;
    if (status !== 'signed-in') { onNeedSignIn?.(); return; }
    if (phase === 'recording') { stop(); return; }
    if (open) { setOpen(false); return; }     // a second press closes what the first press opened
    setOpen(true);
    if (entitled && phase === 'idle') start();
  };

  const close = () => {
    if (phase === 'recording') stop();
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className={'journal-tool journal-talk-tool is-' + phase}
        onClick={press}
        disabled={checking || phase === 'starting'}
        aria-label={phase === 'recording' ? 'Stop and write it down' : 'Talk instead of typing'}
        title={phase === 'recording' ? 'Stop and write it down' : 'Talk instead of typing'}
        aria-expanded={open}
      >
        <Mic size={18} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {open && (
        <div className="journal-talk-sheet" role="dialog" aria-label="Talk">
          {entitled ? (
            <TalkSheet phase={phase} onStop={stop} onClose={close} />
          ) : (
            <LockedSheet onClose={close} onFlash={flash} onRefresh={refresh} />
          )}
          {note && <p className="journal-talk-note">{note}</p>}
        </div>
      )}
    </>
  );
}

// While the browser is still asking for the microphone there is nothing yet to stop, so no control.
const TALK_STATES = {
  starting: 'Waiting for the microphone…',
  recording: 'Listening',
  working: 'Writing it down…',
};

function TalkSheet({ phase, onStop, onClose }) {
  return (
    <>
      <p className="journal-talk-state">{TALK_STATES[phase] ?? 'Talk'}</p>
      <p className="journal-talk-promise">{DISCARD_PROMISE}</p>
      {phase !== 'starting' && (
        <button type="button" className="journal-talk-act" onClick={phase === 'recording' ? onStop : onClose}>
          {phase === 'recording' ? 'Stop and write it down' : 'Close'}
        </button>
      )}
    </>
  );
}

// While `paidPlansOpen()` is false there is no door behind the price; the same button becomes a checkout
// the moment plans arm.
function LockedSheet({ onClose, onFlash, onRefresh }) {
  const openDoor = async () => {
    // The webhook that flips the subscription live can trail checkout.completed, so re-read twice.
    const opened = await beginUpgrade({ onCompleted: () => { onRefresh(); setTimeout(onRefresh, 2500); } });
    if (!opened) onFlash('Couldn’t open checkout');
  };
  return (
    <>
      <p className="journal-talk-state">Talk is part of Windmill One</p>
      <p className="journal-talk-promise">
        {DISCARD_PROMISE}
        {!paidPlansOpen() && ' Windmill One isn’t on sale yet — Talk opens when it is.'}
      </p>
      {paidPlansOpen()
        ? <button type="button" className="journal-talk-act" onClick={openDoor}>See Windmill One</button>
        : <button type="button" className="journal-talk-act" onClick={onClose}>Close</button>}
    </>
  );
}
