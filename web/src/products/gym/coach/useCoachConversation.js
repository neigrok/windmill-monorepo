import { useEffect, useMemo, useRef, useState } from 'react';
import { gymApi } from '../gymApi.js';
import { mintId } from '../mint.js';
import {
  answerTurn, askFailure, generationTurns, mergeTurns, NO_ANSWER_NOTE, questionTooLong,
  requestFromGeneration, THREAD_PREFIX, TOO_LONG_NOTE,
} from './coach.js';
import { coachPhotos } from './photos.js';

export function coachDraftKey(accountId, threadId = 'current') {
  return `windmill.gym.coach.${encodeURIComponent(accountId)}.${threadId}`;
}

export function readCoachDraft(accountId, threadId) {
  if (!accountId) return null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(coachDraftKey(accountId, threadId)));
    if (!stored || typeof stored.thread !== 'string' || !Array.isArray(stored.turns)) return null;
    return stored;
  } catch {
    return null;
  }
}

export function forgetCoachDraft(accountId, threadId) {
  if (!accountId) return;
  try {
    if (!threadId || readCoachDraft(accountId)?.thread === threadId) window.localStorage.removeItem(coachDraftKey(accountId));
    if (threadId) {
      const photo = readCoachDraft(accountId, threadId)?.photo;
      window.localStorage.removeItem(coachDraftKey(accountId, threadId));
      if (photo) coachPhotos.remove(accountId, threadId, photo.id).catch(() => {});
    }
  } catch {
    // Server history remains authoritative when local storage is unavailable.
  }
}

export function useCoachConversation({ accountId, initialThread, workoutInProgress = false, api = gymApi, photos = coachPhotos }) {
  const [state, setState] = useState(() => {
    const stored = readCoachDraft(accountId, initialThread?.id);
    const generation = initialThread?.generation;
    const complete = ['completed', 'stopped'].includes(generation?.status)
      && generation.requestId === stored?.request?.requestId;
    const request = complete ? null : stored?.request ?? requestFromGeneration(initialThread?.id, generation);
    return {
      thread: initialThread?.id ?? stored?.thread ?? mintId(THREAD_PREFIX),
      turns: mergeTurns(stored?.turns ?? [], initialThread?.turns ?? []),
      draft: complete ? '' : stored?.draft ?? request?.question ?? '',
      photo: complete ? null : stored?.photo ? { ...stored.photo, status: 'draft' } : null,
      request, nextCursor: initialThread?.nextCursor ?? null,
      phase: !initialThread && stored ? 'loading' : 'ready',
      busy: false, pending: false, attempt: 0, stopRequested: false, note: '', closed: '',
    };
  });
  const current = useRef(state);
  const workout = useRef(workoutInProgress);
  workout.current = workoutInProgress;
  const mounted = useRef(true);
  const active = useRef(false);
  const stream = useRef(null);
  const upload = useRef(null);

  const change = (patch, { durable = false } = {}) => {
    const next = { ...current.current, ...patch };
    if (accountId) {
      try {
        const stored = JSON.stringify({ thread: next.thread, turns: next.turns.slice(-50), draft: next.draft,
          request: next.request, photo: next.photo });
        window.localStorage.setItem(coachDraftKey(accountId, next.thread), stored);
        if (!initialThread) window.localStorage.setItem(coachDraftKey(accountId), stored);
      } catch {
        if (durable) {
          const refused = { ...current.current, note: 'Your browser couldn’t save this question. Allow local storage and try again.' };
          current.current = refused;
          if (mounted.current) setState(refused);
          return false;
        }
      }
    }
    current.current = next;
    if (mounted.current) setState(next);
    return true;
  };

  const snapshot = ({ generation }) => {
    if (!mounted.current || !generation) return;
    const previous = current.current.turns.find((turn) => turn.from === 'ask' && turn.requestId === generation.requestId);
    if (Number.isInteger(generation.revision) && generation.revision <= (previous?.revision ?? -1)) return;
    const terminal = ['completed', 'stopped'].includes(generation.status);
    const photo = current.current.photo;
    change({ turns: mergeTurns(current.current.turns, generationTurns(generation)),
      request: terminal ? null : { ...(current.current.request ?? requestFromGeneration(current.current.thread, generation)), accepted: true },
      ...(terminal ? { draft: '', photo: null, attempt: 0, pending: false, stopRequested: false } : {}),
      ...(generation.status === 'failed' ? { note: 'Response interrupted.', pending: false, stopRequested: false } : {}),
      ...(generation.status === 'stopped' ? { note: '' } : {}),
      ...(generation.status === 'completed' ? { note: '' } : {}),
      ...(generation.status === 'running' && generation.stopRequested ? { stopRequested: true } : {}),
    });
    if (terminal && photo) photos.remove(accountId, current.current.thread, photo.id).catch(() => {});
  };

  const uploadPhoto = async (photo = current.current.photo) => {
    if (workout.current || !photo || upload.current) return false;
    const thread = current.current.thread;
    const controller = new AbortController();
    upload.current = controller;
    change({ photo: { ...photo, status: 'uploading', progress: 0, note: '' } });
    try {
      const blob = await photos.load(accountId, thread, photo.id);
      if (!mounted.current || current.current.photo?.id !== photo.id) return false;
      if (workout.current) {
        change({ photo: { ...photo, status: 'draft', progress: 0, note: '' } });
        return false;
      }
      if (!blob) throw new Error('Choose the photo again to upload it.');
      const metadata = await api.uploadCoachPhoto(thread, photo.id, blob, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (mounted.current && current.current.photo?.id === photo.id) change({ photo: { ...current.current.photo, progress } });
        },
      });
      if (!mounted.current || current.current.photo?.id !== photo.id) return false;
      change({ photo: { ...metadata, status: 'ready', progress: 1 } });
      return true;
    } catch (error) {
      if (mounted.current && current.current.photo?.id === photo.id) {
        change({ photo: { ...photo, status: 'failed', progress: 0,
          note: error.name === 'AbortError' ? 'Upload canceled.' : error.detail || error.message || 'Photo didn’t upload.' } });
      }
      return false;
    } finally {
      if (upload.current === controller) upload.current = null;
    }
  };

  const selectPhoto = async (file) => {
    if (workout.current || !file || !accountId || current.current.request || current.current.photo || current.current.photoBusy) return;
    change({ photoBusy: true, note: '' });
    let id;
    try {
      const { blob, ...metadata } = await photos.prepare(file);
      if (!mounted.current) return;
      id = mintId('img_');
      const thread = current.current.thread;
      await photos.save(accountId, thread, id, blob);
      if (!mounted.current) {
        await photos.remove(accountId, thread, id);
        return;
      }
      const photo = { ...metadata, id, status: 'draft' };
      if (!change({ photo, photoBusy: false }, { durable: true })) {
        await photos.remove(accountId, current.current.thread, id);
        return;
      }
      if (workout.current) return;
      await uploadPhoto(photo);
    } catch (error) {
      if (mounted.current) change({ note: id ? 'Your browser couldn’t save this photo. Allow local storage and try again.' : error.message });
    } finally {
      if (mounted.current) change({ photoBusy: false });
    }
  };

  const send = async (retryTurn) => {
    if (workout.current || active.current || current.current.phase !== 'ready' || current.current.closed) return;
    if (!accountId) { change({ note: 'Confirming your account. Try again in a moment.' }); return; }
    let request = current.current.request;
    const retry = Boolean(request || retryTurn);
    if (retryTurn) {
      if (request && request.requestId !== retryTurn.requestId) {
        change({ note: 'Retry your saved question before retrying another response.' });
        return;
      }
      const question = current.current.turns.find((turn) => turn.from === 'lifter' && turn.requestId === retryTurn.requestId);
      if (!question) return;
      request = { thread: current.current.thread, requestId: retryTurn.requestId, question: question.text, at: question.at,
        attachmentIds: (question.attachments ?? []).map((photo) => photo.id), attachments: question.attachments ?? [], accepted: true };
    }
    if (current.current.photo && current.current.photo.status !== 'ready') {
      if (!await uploadPhoto()) return;
    }
    if (workout.current || !mounted.current) return;
    if (!request) {
      const question = current.current.draft.trim();
      const photo = current.current.photo;
      if (!question && !photo) return;
      if (questionTooLong(question)) { change({ note: TOO_LONG_NOTE }); return; }
      const attachments = photo ? [{ id: photo.id, mediaType: photo.mediaType, width: photo.width, height: photo.height, bytes: photo.bytes }] : [];
      request = { thread: current.current.thread, requestId: mintId('ask_'), question, at: Date.now(),
        attachmentIds: attachments.map((image) => image.id), attachments };
    }
    if (!change({ request, draft: request.question, busy: true, pending: false, note: '' }, { durable: true })) return;
    active.current = true;
    const controller = new AbortController();
    stream.current = controller;
    try {
      const options = { attachmentIds: request.attachmentIds ?? [], signal: controller.signal, onSnapshot: snapshot };
      const reply = api.askStream
        ? await api.askStream(request.thread, request.question, request.requestId, options)
        : await api.ask(request.thread, request.question, request.requestId, options);
      if (!mounted.current) return;
      if (reply.generation) snapshot(reply);
      if (reply.pending || reply.generation?.status === 'running') {
        change({ pending: true, attempt: current.current.attempt + 1 });
        return;
      }
      if (reply.generation) return;
      const answer = answerTurn(reply);
      if (!answer) throw new Error(NO_ANSWER_NOTE);
      const turns = [
        { from: 'lifter', text: request.question, at: request.at, requestId: request.requestId, ...(request.attachments?.length ? { attachments: request.attachments } : {}) },
        { ...answer, at: request.at, requestId: request.requestId, status: 'completed' },
      ];
      const photo = current.current.photo;
      change({ turns: mergeTurns(current.current.turns, turns), request: null, draft: '', photo: null, attempt: 0 });
      if (photo) photos.remove(accountId, request.thread, photo.id).catch(() => {});
    } catch (error) {
      if (!mounted.current || (error.name === 'AbortError' && !current.current.request)) return;
      const failure = askFailure(error);
      if (error.generation) snapshot({ generation: error.generation });
      const photo = current.current.photo;
      const missingPhoto = error.code === 'ask-attachment-invalid' && request.attachmentIds?.includes(photo?.id);
      const known = retry || current.current.request?.accepted || current.current.turns.length || initialThread;
      const unavailable = failure.fresh && known;
      change({ note: api.askStream && !error.detail ? 'Response interrupted.' : failure.note, closed: unavailable ? 'thread' : failure.gone ? 'account' : '', pending: Boolean(current.current.stopRequested),
        ...(current.current.stopRequested ? { attempt: current.current.attempt + 1 } : {}),
        ...(missingPhoto ? { photo: { ...photo, status: 'failed', progress: 0, note: 'The saved upload is no longer available.' }, note: '' } : {}),
        ...(failure.refused && !missingPhoto && !retry && !error.generation && !current.current.request?.accepted ? { request: null } : {}),
        ...(failure.fresh && !known ? { thread: mintId(THREAD_PREFIX), turns: [] } : {}),
      });
    } finally {
      active.current = false;
      if (stream.current === controller) stream.current = null;
      if (mounted.current) change({ busy: false });
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const stop = async () => {
    const request = current.current.request;
    if (!request || current.current.stopBusy) return;
    change({ stopBusy: true, note: '' });
    try {
      const reply = await api.stopCoach(request.thread, request.requestId);
      if (!mounted.current) return;
      snapshot(reply);
      const answer = current.current.turns.find((turn) => turn.from === 'ask' && turn.requestId === request.requestId);
      if (['completed', 'failed', 'stopped'].includes(answer?.status)) {
        change({ stopRequested: false, pending: false });
        stream.current?.abort();
      } else change({ stopRequested: true, pending: !active.current });
    } catch {
      if (mounted.current) change({ note: 'Stop didn’t reach Coach. Try again.', stopRequested: false });
    } finally {
      if (mounted.current) change({ stopBusy: false });
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (current.current.phase === 'loading') {
      api.thread(current.current.thread, { limit: 50 }).then((thread) => {
        if (!mounted.current) return;
        if (!thread) {
          if (current.current.turns.length) {
            forgetCoachDraft(accountId, current.current.thread);
            change({ phase: 'ready', turns: [], request: null, photo: null, draft: '', closed: 'thread', note: 'That conversation isn’t here any more.' });
            return;
          }
          change({ phase: 'ready' });
          return;
        }
        change({ phase: 'ready', turns: mergeTurns(current.current.turns, thread.turns), nextCursor: thread.nextCursor ?? null });
        const generation = thread.generation;
        if (generation && (!current.current.request || generation.requestId === current.current.request.requestId)) {
          const request = requestFromGeneration(thread.id, generation);
          change({ request, draft: request?.question ?? '',
            ...(!request ? { photo: null } : {}), pending: generation.status === 'running' });
        }
      }).catch(() => {
        if (mounted.current) change({ phase: 'ready', note: 'The conversation didn’t refresh. Your question is saved; retry when connected.' });
      });
    } else if (initialThread?.generation?.status === 'running') {
      change({ pending: true });
    }
    const reconnect = () => {
      const request = current.current.request;
      const answer = current.current.turns.find((turn) => turn.from === 'ask' && turn.requestId === request?.requestId);
      if (request && !current.current.closed && answer?.status !== 'failed') sendRef.current();
    };
    window.addEventListener('online', reconnect);
    return () => {
      mounted.current = false;
      stream.current?.abort();
      upload.current?.abort();
      window.removeEventListener('online', reconnect);
    };
  }, []);

  useEffect(() => {
    if (workoutInProgress || !state.pending || state.busy) return undefined;
    const timer = setTimeout(() => sendRef.current(), Math.min(1000 * (2 ** state.attempt), 15000));
    return () => clearTimeout(timer);
  }, [state.pending, state.busy, state.attempt, workoutInProgress]);

  const older = async () => {
    if (!current.current.nextCursor || current.current.olderBusy) return;
    change({ olderBusy: true, olderNote: '' });
    try {
      const page = await api.thread(current.current.thread, { limit: 50, before: current.current.nextCursor });
      if (!mounted.current) return;
      if (!page) throw new Error();
      change({ turns: mergeTurns(current.current.turns, page.turns), nextCursor: page.nextCursor ?? null });
    } catch {
      if (mounted.current) change({ olderNote: 'Earlier messages didn’t load. Try again.' });
    } finally {
      if (mounted.current) change({ olderBusy: false });
    }
  };

  const turns = useMemo(() => {
    if (!state.request || state.turns.some((turn) => turn.from === 'lifter' && turn.requestId === state.request.requestId)) return state.turns;
    return [...state.turns, { from: 'lifter', text: state.request.question, requestId: state.request.requestId, at: state.request.at,
      ...(state.request.attachments?.length ? { attachments: state.request.attachments } : {}) }];
  }, [state.turns, state.request]);

  return {
    ...state, turns,
    send, stop, older, selectPhoto, uploadPhoto,
    cancelUpload: () => upload.current?.abort(),
    removePhoto: async () => {
      if (current.current.request) return;
      upload.current?.abort();
      const photo = current.current.photo;
      change({ photo: null });
      if (photo) await photos.remove(accountId, current.current.thread, photo.id).catch(() => {});
    },
    setDraft: (draft) => change({ draft }),
    newChat: () => {
      if (active.current || upload.current || current.current.photoBusy) return;
      forgetCoachDraft(accountId);
      change({ thread: mintId(THREAD_PREFIX), turns: [], draft: '', photo: null, request: null, nextCursor: null,
        pending: false, attempt: 0, stopRequested: false, note: '', closed: '' });
    },
  };
}
