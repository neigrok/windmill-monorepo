// Talk: speak a page instead of typing it. A press settles what it can before the microphone opens: signed out it opens
// the sign-in door, without Windmill One it shows the locked face, and with an allowance that cannot fund a take it says
// so without recording one. A take goes to the voice endpoint and its transcript drops into today. A take the server
// refuses stays in this tab (talkStore.js) — in the sheet, or behind a dot on the mic once the sheet closes, and across
// the room being left and come back to — until it is written down, downloaded or discarded; leaving the page asks first
// and nothing keeps it past a reload. Every refusal keeps the take, and none retires Talk. A browser without
// MediaRecorder never shows it.

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Pause, X } from 'lucide-react';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { useEntitlements } from '../../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../../shell/billing/checkout.js';
import { track } from '../../../telemetry/beacon.js';
import { captureError } from '../../../telemetry/sentry.js';
import { Refusal } from './refusal.js';
import { Take, levelsOf } from './take.js';
import { AUDIO_CAP_BYTES, TalkError, talkApi } from './talkApi.js';
import { talkStore } from './talkStore.js';
import { t } from '../i18n/index.js';

// The recorder hands its audio over each second and stops itself short of the server's cap, so a long take is written
// down rather than refused.
const SLICE_MS = 1000;
// The refusal takes the state line's place in a cross-fade: 280 ms on --ease-standard.
const STATE_FADE = { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

function pickMime() {
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

// One send of a take's audio. It settles into talkStore whether or not the room is still there: a transcript goes into
// today, now or when the room comes back, and a refusal keeps the take under the face that says why. A 401 has the
// account check itself, and a 403 re-reads the plan so the mic re-locks. The answer is the error, or null once written.
async function send(audio, { kept = null, recording = null, renews = null, account, plan }) {
  const ticket = talkStore.begin();
  let text;
  try {
    text = (await talkApi.transcribe(audio)).trim();
  } catch (error) {
    const refusal = Refusal.ofAnswer(error, { renews: await (renews ?? talkApi.renews()) });
    if (error?.status === 401) {
      talkStore.needSignIn(true);
      account.recheck?.().then((me) => { if (me) talkStore.needSignIn(false); }).catch(() => {});
    }
    if (error?.status === 403) plan.refresh();
    talkStore.kept(ticket, kept ?? new Take({ ...recording, audio, levels: await levelsOf(audio) }), refusal);
    return error;
  }
  if (talkStore.written(ticket, text) && text) track('journal_talk_take', { action: 'written' });
  return null;
}

export function TalkButton({ onTranscript, onNeedSignIn }) {
  // `reading` and `starting` are phases of their own: without them a second press opens a second recorder over the
  // first, and the first stream is then released by nothing. A send is talkStore's, so it outlives the room.
  const [phase, setPhase] = useState('idle');   // idle | reading | starting | recording
  const [open, setOpen] = useState(false);      // the sheet
  const [note, setNote] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [, setTick] = useState(0);
  const { take, face, discarded, sending, signInNeeded } = useSyncExternalStore(talkStore.subscribe, talkStore.snapshot);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const stateLine = useRef(null);
  // Whether the plan renews, read when the sheet opens so a refusal can name its date without waiting.
  const renews = useRef(null);
  const mounted = useRef(false);
  const latest = useRef({});
  const lastStatus = useRef(null);
  const { status, refresh: recheckAccount } = useAuth();
  const { loading: entLoading, windmillOne, refresh: refreshPlan } = useEntitlements();
  latest.current = { onTranscript, close: () => close() };

  // The room's way into today; a transcript that landed while the room was away is written as it comes back. Leaving
  // the room mid-take stops the recorder, which sends what it heard: the mic is never left hot, and the take is kept.
  useEffect(() => {
    mounted.current = true;
    const detach = talkStore.attach((text) => latest.current.onTranscript(text));
    return () => {
      mounted.current = false;
      detach();
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (status === 'signed-in' && lastStatus.current !== null && lastStatus.current !== 'signed-in') talkStore.needSignIn(false);
    lastStatus.current = status;
  }, [status]);

  // Escape closes the sheet, as pressing the tool again does.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || phase === 'reading' || phase === 'starting') return;
      latest.current.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase]);

  // While a take is held, Try again waits for the browser to say it is online.
  useEffect(() => {
    if (!take) return undefined;
    const connectivity = () => setOnline(navigator.onLine !== false);
    connectivity();
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    return () => {
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
    };
  }, [take]);

  // A face is told to telemetry once, when a sheet first shows it — never for an answer that landed while no sheet did.
  useEffect(() => {
    if (open && face && talkStore.announce(face)) {
      track('journal_talk_refused', { code: face.refusal.code, reason: face.refusal.reason, moment: face.moment });
    }
  }, [open, face]);

  // The face redraws when its date comes, so a kept take whose wait is over offers Try again.
  const returnsAt = face?.refusal.returnsAt ?? null;
  useEffect(() => {
    const wait = returnsAt === null ? 0 : returnsAt - Date.now();
    if (!open || wait <= 0 || wait > 2 ** 31 - 1) return undefined;
    const timer = setTimeout(() => setTick((tick) => tick + 1), wait + 50);
    return () => clearTimeout(timer);
  }, [open, returnsAt]);

  // The state line is the sheet's polite live region; a refusal fades into it in place.
  const refusalText = face?.refusal.sentence ?? null;
  useEffect(() => {
    if (!refusalText || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    stateLine.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], STATE_FADE);
  }, [refusalText]);

  if (typeof window === 'undefined' || !window.MediaRecorder) return null;

  const shown = sending ? 'working' : phase;
  const entitled = status === 'signed-in' && windmillOne;
  const checking = status === 'signed-in' && entLoading;
  const busy = checking || phase === 'reading' || phase === 'starting';
  const waiting = Boolean(take) && !open && !sending;
  const flash = (message) => { setNote(message); setTimeout(() => setNote(''), 3000); };
  const collaborators = { account: { recheck: recheckAccount }, plan: { refresh: refreshPlan } };

  const writeDown = async (recording) => {
    setPhase('idle');
    const error = await send(recording.audio, { recording, renews: renews.current, ...collaborators });
    if (!error && mounted.current) setOpen(false);
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

  // The allowance and the plan are read before the microphone is asked: a refusal only a date lifts is said now, with
  // no take made. "Waiting for the microphone…" shows only once the microphone is asked.
  const begin = async () => {
    setPhase('reading');
    renews.current = talkApi.renews();
    const allowance = await talkApi.allowance();
    const blocked = allowance && Refusal.beforeTake(allowance, { renews: await renews.current });
    if (blocked) {
      setPhase('idle');
      talkStore.show(blocked, 'before_take');
      return;
    }
    setPhase('starting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase('idle');
      flash(t('journal.talk.noMicrophone'));
      return;
    }
    // A microphone granted after the room has gone is released at once, never left hot.
    if (!mounted.current) { stream.getTracks().forEach((track) => track.stop()); return; }
    record(stream);
  };

  const stop = () => recorderRef.current?.stop();

  const close = () => {
    if (phase === 'recording') stop();
    if (take && face) track('journal_talk_take', { action: 'close' });
    talkStore.dismiss();
    setOpen(false);
  };

  const press = () => {
    if (busy) return;
    if (phase === 'recording') { stop(); return; }
    if (open) { close(); return; }     // a second press closes what the first press opened
    if (take || sending) { setOpen(true); return; }   // a kept or travelling take comes back as it was left
    if (status !== 'signed-in') { onNeedSignIn?.(); return; }
    setOpen(true);
    const blocking = talkStore.blocking(Date.now());
    if (blocking) { talkStore.show(blocking, 'remembered'); return; }
    if (entitled && phase === 'idle') begin();
  };

  const retry = async () => {
    track('journal_talk_take', { action: 'retry' });
    const error = await send(take.audio, { kept: take, ...collaborators });
    track('journal_talk_retry', { outcome: !error ? 'written' : error instanceof TalkError ? 'refused' : 'unreachable' });
    if (!error && mounted.current) setOpen(false);
  };

  const acts = {
    download: () => track('journal_talk_take', { action: 'download' }),
    retry,
    signIn: () => { track('journal_talk_take', { action: 'sign_in' }); onNeedSignIn?.(); },
    close,
  };
  const discard = () => { track('journal_talk_take', { action: 'discard' }); talkStore.discard(); };
  const undo = () => { track('journal_talk_take', { action: 'undo' }); talkStore.undo(); };

  const refusal = sending ? null : face?.refusal ?? null;
  const talking = entitled || sending;
  const stateText = refusal ? refusal.sentence : talking ? TALK_STATES[shown] ?? t('journal.talk.title') : t('journal.talk.locked');
  const label = phase === 'recording' ? t('journal.talk.stop') : waiting ? t('journal.talk.takeWaiting') : t('journal.talk.start');
  return (
    <>
      <button
        type="button"
        className={'journal-tool journal-talk-tool is-' + shown + (waiting ? ' has-take' : '')}
        onClick={press}
        disabled={busy}
        aria-label={label}
        title={label}
        aria-expanded={open}
      >
        <Mic size={18} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {open && (
        <div className="journal-talk-sheet" role="dialog" aria-label={t('journal.talk.title')}>
          <p ref={stateLine} className="journal-talk-state" role="status">{stateText}</p>
          {refusal ? (
            <RefusedSheet
              refusal={refusal}
              take={take}
              discarded={Boolean(discarded)}
              acts={refusal.acts({ holding: Boolean(take), signedIn: status === 'signed-in' && !signInNeeded, now: Date.now() })}
              online={online}
              on={acts}
              onDiscard={discard}
              onUndo={undo}
            />
          ) : talking ? (
            <TalkSheet phase={shown} onStop={stop} onClose={close} />
          ) : (
            <LockedSheet onClose={close} onFlash={flash} onRefresh={refreshPlan} />
          )}
          {note && <p className="journal-talk-note">{note}</p>}
        </div>
      )}
    </>
  );
}

// While the account and plan are read, or the browser is still asking for the microphone, there is nothing yet to stop,
// so no control.
const TALK_STATES = {
  starting: t('journal.talk.waiting'),
  recording: t('journal.talk.listening'),
  working: t('journal.talk.writing'),
};

function TalkSheet({ phase, onStop, onClose }) {
  return (
    <>
      <p className="journal-talk-detail">{t('journal.talk.promise')}</p>
      {phase !== 'reading' && phase !== 'starting' && (
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

// Figma Journal · Web · `Talk sheet · refused`: when Talk is back, the kept take and at most two acts, the first in the
// lamp, under the state line the sheet already holds. Try again is offered only where trying again can work, and waits
// while offline. Focus follows the person: to the first act when a refusal arrives, to Undo after ×, back to the take
// after Undo, and to the first act again once Undo has gone.
function RefusedSheet({ refusal, take, discarded, acts, online, on, onDiscard, onUndo }) {
  const firstAct = useRef(null);
  const undoAct = useRef(null);
  const play = useRef(null);
  const shownTake = useRef(take);
  useEffect(() => { firstAct.current?.focus(); }, [refusal]);
  useEffect(() => {
    if (discarded) undoAct.current?.focus();
    else if (!take) firstAct.current?.focus();
  }, [discarded, take]);
  useEffect(() => {
    if (take && !shownTake.current) play.current?.focus();
    shownTake.current = take;
  }, [take]);
  return (
    <div className="journal-talk-refused">
      {refusal.detail && <p className="journal-talk-detail">{refusal.detail}</p>}
      {take && <TakeStrip take={take} play={play} onDiscard={onDiscard} />}
      <div className="journal-talk-acts">
        {acts.map((act, index) => {
          const className = 'journal-talk-act' + (index > 0 ? ' is-quiet' : '');
          const ref = index === 0 ? firstAct : undefined;
          if (act === 'download') {
            return <a key={act} ref={ref} className={className} href={take.url} download={take.filename} onClick={on.download}>{ACT_LABELS.download}</a>;
          }
          return (
            <button key={act} ref={ref} type="button" className={className} onClick={on[act]} disabled={act === 'retry' && !online}>
              {ACT_LABELS[act]}
            </button>
          );
        })}
      </div>
      {discarded && (
        <p className="journal-talk-undo">
          {t('journal.talk.take.discarded', {
            undo: <button ref={undoAct} type="button" className="journal-talk-undo-act" onClick={onUndo}>{t('journal.talk.take.undo')}</button>,
          })}
        </p>
      )}
    </div>
  );
}

// The kept take: play it back, see its shape and length, or let it go.
function TakeStrip({ take, play, onDiscard }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (playing) { audio.current.pause(); return; }
    audio.current.play().catch(() => captureError('journal', 'journal-talk-playback', '', '/journal'));
  };
  return (
    <div className="journal-talk-take">
      <div className="journal-talk-strip">
        <button ref={play} type="button" className="journal-talk-play" onClick={toggle}
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
