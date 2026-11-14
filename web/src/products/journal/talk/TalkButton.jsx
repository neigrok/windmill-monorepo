// Talk: speak a page instead of typing it. A press settles what it can before the microphone opens: signed out it opens
// the sign-in door, without Windmill One it shows the locked face, and with an allowance that cannot fund a take it says
// so without recording one. A take goes to the voice endpoint and its transcript drops into today. A take the server
// refuses stays in this tab — in the sheet, or behind a dot on the mic once the sheet closes — until it is written down,
// downloaded or discarded, and leaving the page asks first; nothing keeps it past a reload. Every refusal keeps the
// take, and none retires Talk. A browser without MediaRecorder never shows it.

import React, { useEffect, useRef, useState } from 'react';
import { Mic, Pause, X } from 'lucide-react';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../../shell/billing/checkout.js';
import { track } from '../../../telemetry/beacon.js';
import { captureError } from '../../../telemetry/sentry.js';
import { Refusal } from './refusal.js';
import { Take, levelsOf } from './take.js';
import { AUDIO_CAP_BYTES, TalkError, talkApi } from './talkApi.js';
import { t } from '../i18n/index.js';

// How long a discarded take can still come back with Undo: the toast hold with an action (motion-language.md).
const DISCARD_HOLD_MS = 6000;
// The recorder hands its audio over each second and stops itself short of the server's cap, so a long take is written
// down rather than refused.
const SLICE_MS = 1000;

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
  const [phase, setPhase] = useState('idle');   // idle | starting | recording | working
  const [open, setOpen] = useState(false);      // the sheet
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState(null);     // the face the sheet shows in place of its own state
  const [take, setTake] = useState(null);           // the refused take this tab holds
  const [discarded, setDiscarded] = useState(null); // a take × let go, back with Undo until its hold ends
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const discardTimer = useRef(null);
  // The refusal only a date lifts, said again on every press until then.
  const remembered = useRef(null);
  // Whether the plan renews, read when the sheet opens and asked only when a refusal would name a date.
  const renews = useRef(Promise.resolve(false));
  const latest = useRef({});
  const { status } = useAuth();
  const { loading: entLoading, windmillOne, refresh } = useEntitlements();
  latest.current = { ...latest.current, take, discarded, close: () => close() };

  // Leaving the page must never leave the mic hot, nor hold a take's memory past the page.
  useEffect(() => () => {
    latest.current.gone = true;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    clearTimeout(discardTimer.current);
    latest.current.take?.release();
    latest.current.discarded?.release();
  }, []);

  // Escape closes the sheet, as pressing the tool again does.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || phase === 'starting') return;
      latest.current.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase]);

  // While a take is held, leaving the page asks first, and Try again waits for the browser to say it is online.
  useEffect(() => {
    if (!take) return undefined;
    const ask = (event) => { event.preventDefault(); event.returnValue = ''; };
    const connectivity = () => setOnline(navigator.onLine !== false);
    connectivity();
    window.addEventListener('beforeunload', ask);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    return () => {
      window.removeEventListener('beforeunload', ask);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
    };
  }, [take]);

  if (typeof window === 'undefined' || !window.MediaRecorder) return null;

  const entitled = status === 'signed-in' && windmillOne;
  const checking = status === 'signed-in' && entLoading;
  const waiting = Boolean(take) && !open && phase !== 'working';
  const flash = (message) => { setNote(message); setTimeout(() => setNote(''), 3000); };

  const refuse = (shown, moment) => {
    setRefusal(shown);
    track('journal_talk_refused', { code: shown.code, reason: shown.reason, moment });
  };

  // One send of a take's audio, the phase `working` until whoever sent it settles what the answer means. The answer is
  // the error, or null once the transcript is in today and the sheet has closed.
  const transcribe = async (audio) => {
    setPhase('working');
    try {
      const text = await talkApi.transcribe(audio);
      if (text && text.trim()) onTranscript(text.trim());
      setPhase('idle');
      setOpen(false);
      return null;
    } catch (error) {
      return error;
    }
  };

  // A refused take stays, under the face that says why. A lapsed subscription re-syncs, so the mic re-locks.
  const hold = async (kept, error) => {
    const refused = Refusal.ofAnswer(error, { renews: await renews.current });
    if (error?.status === 403) refresh();
    if (refused.until !== null) remembered.current = refused;
    setTake(kept);
    setPhase('idle');
    refuse(refused, 'take');
  };

  const writeDown = async (recording) => {
    const error = await transcribe(recording.audio);
    if (error) await hold(new Take({ ...recording, levels: await levelsOf(recording.audio) }), error);
  };

  const record = (stream) => {
    streamRef.current = stream;
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    let bytes = 0;
    const startedAt = performance.now();
    const recordedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (recorder.state === 'recording' && bytes + 2 * event.data.size >= AUDIO_CAP_BYTES) recorder.stop();
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const audio = new Blob(chunks, { type: mime || recorder.mimeType || 'audio/webm' });
      writeDown({ audio, durationMs: performance.now() - startedAt, recordedAt });
    };
    recorderRef.current = recorder;
    recorder.start(SLICE_MS);
    setPhase('recording');
  };

  // The allowance is read before the microphone opens: a refusal only a date lifts is said now, with no take made.
  const begin = async () => {
    setPhase('starting');
    renews.current = talkApi.renews();
    const allowance = await talkApi.allowance();
    const blocked = allowance && Refusal.beforeTake(allowance, { renews: await renews.current });
    if (blocked) {
      remembered.current = blocked;
      setPhase('idle');
      refuse(blocked, 'before_take');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase('idle');
      flash(t('journal.talk.noMicrophone'));
      return;
    }
    // A microphone granted after the room has gone is released at once, never left hot.
    if (latest.current.gone) { stream.getTracks().forEach((track) => track.stop()); return; }
    record(stream);
  };

  const stop = () => recorderRef.current?.stop();

  // A discarded take's hold ends early when the sheet closes: Undo goes with the sheet.
  const letGo = () => {
    clearTimeout(discardTimer.current);
    discarded?.release();
    setDiscarded(null);
  };

  const close = () => {
    if (phase === 'recording') stop();
    if (discarded) letGo();
    if (take && refusal) track('journal_talk_take', { action: 'close' });
    if (!take) setRefusal(null);   // a face with nothing held goes with the sheet; one holding a take waits behind the dot
    setOpen(false);
  };

  const press = () => {
    if (checking || phase === 'starting') return;
    if (phase === 'recording') { stop(); return; }
    if (open) { close(); return; }     // a second press closes what the first press opened
    if (take) { setOpen(true); return; }   // the kept take comes back as it was left, never a new recording
    if (status !== 'signed-in') { onNeedSignIn?.(); return; }
    setOpen(true);
    if (remembered.current?.blocks(Date.now())) { refuse(remembered.current, 'remembered'); return; }
    if (entitled && phase === 'idle') begin();
  };

  const retry = async () => {
    track('journal_talk_take', { action: 'retry' });
    setRefusal(null);
    const error = await transcribe(take.audio);
    track('journal_talk_retry', { outcome: !error ? 'written' : error instanceof TalkError ? 'refused' : 'unreachable' });
    if (error) { await hold(take, error); return; }
    take.release();
    setTake(null);
  };

  const discard = () => {
    track('journal_talk_take', { action: 'discard' });
    const gone = take;
    setTake(null);
    setDiscarded(gone);
    discardTimer.current = setTimeout(() => { gone.release(); setDiscarded(null); }, DISCARD_HOLD_MS);
  };

  const undo = () => {
    track('journal_talk_take', { action: 'undo' });
    clearTimeout(discardTimer.current);
    setTake(discarded);
    setDiscarded(null);
  };

  const acts = {
    download: () => track('journal_talk_take', { action: 'download' }),
    retry,
    signIn: () => { track('journal_talk_take', { action: 'sign_in' }); onNeedSignIn?.(); },
    close,
  };

  const label = phase === 'recording' ? t('journal.talk.stop') : waiting ? t('journal.talk.takeWaiting') : t('journal.talk.start');
  return (
    <>
      <button
        type="button"
        className={'journal-tool journal-talk-tool is-' + phase + (waiting ? ' has-take' : '')}
        onClick={press}
        disabled={checking || phase === 'starting'}
        aria-label={label}
        title={label}
        aria-expanded={open}
      >
        <Mic size={18} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {open && (
        <div className="journal-talk-sheet" role="dialog" aria-label={t('journal.talk.title')}>
          {refusal ? (
            <RefusedSheet
              refusal={refusal}
              take={take}
              discarded={Boolean(discarded)}
              acts={refusal.acts({ holding: Boolean(take), signedIn: status === 'signed-in' })}
              online={online}
              on={acts}
              onDiscard={discard}
              onUndo={undo}
            />
          ) : entitled ? (
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
  starting: t('journal.talk.waiting'),
  recording: t('journal.talk.listening'),
  working: t('journal.talk.writing'),
};

function TalkSheet({ phase, onStop, onClose }) {
  return (
    <>
      <p className="journal-talk-state">{TALK_STATES[phase] ?? t('journal.talk.title')}</p>
      <p className="journal-talk-detail">{t('journal.talk.promise')}</p>
      {phase !== 'starting' && (
        <div className="journal-talk-acts">
          <button type="button" className="journal-talk-act" onClick={phase === 'recording' ? onStop : onClose}>
            {phase === 'recording' ? t('journal.talk.stop') : t('journal.talk.close')}
          </button>
        </div>
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
    if (!opened) onFlash(t('journal.talk.checkoutFailed'));
  };
  return (
    <>
      <p className="journal-talk-state">{t('journal.talk.locked')}</p>
      <p className="journal-talk-detail">
        {t('journal.talk.promise')}
        {!paidPlansOpen() && ` ${t('journal.talk.notOnSale')}`}
      </p>
      <div className="journal-talk-acts">
        {paidPlansOpen()
          ? <button type="button" className="journal-talk-act" onClick={openDoor}>{t('journal.talk.seeOffer')}</button>
          : <button type="button" className="journal-talk-act" onClick={onClose}>{t('journal.talk.close')}</button>}
      </div>
    </>
  );
}

const ACT_LABELS = {
  download: t('journal.talk.act.download'),
  retry: t('journal.talk.act.retry'),
  signIn: t('journal.talk.act.signIn'),
  close: t('journal.talk.close'),
};

// Figma Journal · Web · `Talk sheet · refused`: the refusal's sentence, when Talk is back, the kept take and at most two
// acts, the first in the lamp. Try again is offered only where trying again can work, and waits while offline.
function RefusedSheet({ refusal, take, discarded, acts, online, on, onDiscard, onUndo }) {
  return (
    <div className="journal-talk-refused">
      <p className="journal-talk-state">{refusal.sentence}</p>
      {refusal.detail && <p className="journal-talk-detail">{refusal.detail}</p>}
      {take && <TakeStrip take={take} onDiscard={onDiscard} />}
      <div className="journal-talk-acts">
        {acts.map((act, index) => {
          const className = 'journal-talk-act' + (index > 0 ? ' is-quiet' : '');
          if (act === 'download') {
            return <a key={act} className={className} href={take.url} download={take.filename} onClick={on.download}>{ACT_LABELS.download}</a>;
          }
          return (
            <button key={act} type="button" className={className} onClick={on[act]} disabled={act === 'retry' && !online}>
              {ACT_LABELS[act]}
            </button>
          );
        })}
      </div>
      {discarded && (
        <p className="journal-talk-undo">
          {t('journal.talk.take.discarded', {
            undo: <button type="button" className="journal-talk-undo-act" onClick={onUndo}>{t('journal.talk.take.undo')}</button>,
          })}
        </p>
      )}
    </div>
  );
}

// The kept take: play it back, see its shape and length, or let it go.
function TakeStrip({ take, onDiscard }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (playing) { audio.current.pause(); return; }
    audio.current.play().catch(() => captureError('journal', 'journal-talk-playback', '', '/journal'));
  };
  return (
    <div className="journal-talk-take">
      <div className="journal-talk-strip">
        <button type="button" className="journal-talk-play" onClick={toggle}
          aria-label={playing ? t('journal.talk.take.pause') : t('journal.talk.take.play')}>
          {playing
            ? <Pause size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            : <span className="journal-talk-play-glyph" aria-hidden="true" />}
        </button>
        <span className="journal-talk-wave" aria-hidden="true">
          {take.levels.map((level, index) => <span key={index} style={{ height: `${3 + Math.round(level * 15)}px` }} />)}
        </span>
        <span className="journal-talk-length">{take.length}</span>
        <button type="button" className="journal-talk-discard" onClick={onDiscard}
          aria-label={t('journal.talk.take.discard')} title={t('journal.talk.take.discard')}>
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
        <audio ref={audio} src={take.url} preload="metadata"
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      </div>
      <p className="journal-talk-kept">{t('journal.talk.take.kept')}</p>
    </div>
  );
}
