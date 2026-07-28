// Talk: speak a page instead of typing it. Records with the browser's own recorder, sends the audio to
// the voice endpoint, and drops the transcript straight into today — no separate view, no audio kept
// anywhere (the server transcribes and discards). It hides itself when voice isn't available: a browser
// without a recorder never shows it, and a 503 (no vendor wired) retires it for the session. A 403 is
// the gentle Windmill One line, shown for a moment. The query for text is the only thing that leaves.

import React, { useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { journalApi } from './journalApi.js';

function pickMime() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export function TalkButton({ onTranscript }) {
  const [phase, setPhase] = useState('idle');   // idle | recording | working | hidden
  const [note, setNote] = useState('');
  const recorderRef = useRef(null);

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
        if (error.status === 403) { setPhase('idle'); flash('Talk is part of Windmill One'); }
        else setPhase('hidden');   // 503 (no vendor) or worse — voice isn't available; retire it quietly
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('recording');
  };

  const stop = () => recorderRef.current?.stop();

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
