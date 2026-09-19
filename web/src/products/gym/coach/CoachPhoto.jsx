import React, { useEffect, useState } from 'react';
import { gymApi } from '../gymApi.js';
import { coachPhotos } from './photos.js';

export function CoachPhoto({ accountId, thread, photo, draft = false }) {
  const [view, setView] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let url;
    const controller = new AbortController();
    setView({ phase: 'loading' });
    const read = draft
      ? coachPhotos.load(accountId, thread, photo.id)
      : gymApi.coachPhoto(thread, photo.id, { signal: controller.signal });
    read.then((blob) => {
      if (!live) return;
      if (!blob) throw new Error();
      url = URL.createObjectURL(blob);
      setView({ phase: 'ready', url });
    }).catch(() => { if (live) setView({ phase: 'failed' }); });
    return () => {
      live = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [accountId, thread, photo.id, draft, attempt]);

  if (view.phase === 'failed') return <div className="gym-coach-photo-note">
    <span>Photo couldn’t load.</span>
    <button type="button" className="gym-coach-retry" onClick={() => setAttempt((value) => value + 1)}>Retry photo</button>
  </div>;
  if (view.phase === 'loading') return <div className="gym-coach-photo-placeholder" role="status">Opening photo…</div>;
  const image = <img className="gym-coach-photo" src={view.url} width={photo.width} height={photo.height}
    alt={draft ? 'Photo ready to send' : 'Photo you shared'} />;
  if (draft) return image;
  return <a className="gym-coach-photo-open" href={view.url} target="_blank" rel="noreferrer" aria-label="Open shared photo">{image}</a>;
}
