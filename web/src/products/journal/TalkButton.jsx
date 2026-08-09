// Talk: speak a page instead of typing it. It is a tool, so it lives where the tools live — in the
// rail beside search and the zoom, never floating over the writing and never wearing a price tag.
// Canon (Journal canvas controls, 09 Aug 2026): a badge prices the thing before anyone has asked for
// it, so the button is a glyph and the SHEET states the layer and the discard promise together.
//
// The paywall stays honest UP FRONT — the mic never records a non-subscriber's words only to lose
// them to a 403. A signed-out writer is sent to the door; a signed-in writer without Windmill One is
// told the plan is not open, and once plans arm the same press opens checkout and the mic unlocks
// the moment it completes. Only once entitlement is confirmed does the button record: the browser's
// own recorder captures audio, sends it to the voice endpoint, and drops the transcript straight
// into today — no separate view, no audio kept anywhere (the server transcribes and discards; the
// vendor is OpenAI). It hides itself when voice isn't available: a browser without a recorder never
// shows it, and a 503 (no vendor wired) retires it for the session. The query for text is the only
// thing that leaves.

import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { journalApi } from './journalApi.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../shell/billing/checkout.js';

// Said in the sheet, every time, before a word is spoken — not in a footnote and not once ever.
const DISCARD_PROMISE = 'The recording is transcribed and thrown away. No audio is kept anywhere.';

function pickMime() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export function TalkButton({ onTranscript, onNeedSignIn }) {
  // starting is a phase of its own because asking for the microphone is SLOW — the permission
  // prompt is seconds of a live UI still reading 'idle'. Without it a second press inside that
  // window opens a second recorder over the first, and the first stream is then held by nothing:
  // no onstop will ever release it and the unmount cleanup can only see the last one, so the
  // browser's recording light stays on until the tab closes.
  const [phase, setPhase] = useState('idle');   // idle | starting | recording | working | hidden
  const [open, setOpen] = useState(false);      // the sheet — closed is the resting state
  const [note, setNote] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const { status } = useAuth();
  const { loading: entLoading, windmillOne, refresh } = useEntitlements();

  // Leaving the page mid-sentence must never leave the mic hot: release the stream on unmount.
  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  // Escape closes the sheet, and closing it stops a recording — the same as pressing the tool
  // again. A dialog that only its own link can dismiss is a dialog you can be stuck in.
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
        setOpen(false);            // the words are in the page; the sheet has nothing left to say
      } catch (error) {
        // The up-front gate makes these the rare races — a session or subscription that lapsed
        // between the check and the send. Re-sync the truth so the mic re-locks rather than lying.
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

  // One press, three readings of the same state. A signed-out writer never opens a sheet about a
  // plan — the door is what they need. An entitled writer's press IS the record, and the sheet that
  // opens with it is where the promise is made. Everyone else gets the sheet, and it is honest.
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

// Recording. The one sentence about the audio is on screen while the audio exists — that is the
// whole point of moving it off the button and into here. While the browser is still asking for the
// microphone there is nothing to stop and nothing to close, so the sheet says what it is waiting
// for and offers no control that would race the recorder into existence.
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

// The paywall, said in full before a single word is spoken: which layer this is, what happens to the
// audio, and — while Windmill One is not on sale (shell/billing/checkout.js — paidPlansOpen) — that
// there is no door behind the price yet. Sending this writer to a checkout would spend their press
// on a failure. The moment plans arm, the same button is a checkout again.
function LockedSheet({ onClose, onFlash, onRefresh }) {
  const openDoor = async () => {
    // The webhook that flips the subscription live can trail checkout.completed by a beat, so
    // re-read once now and once shortly after rather than leaving the mic locked on a paid account.
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
