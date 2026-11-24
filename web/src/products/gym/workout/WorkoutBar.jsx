import React, { useEffect, useState } from 'react';
import { Dumbbell } from 'lucide-react';
import { useGymApi, workoutStep } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { clockOf, WORKOUT_HREF } from '../log.js';
import { useDomainRead } from '../useDomainRead.js';
import { clocksAt, tabTitle, workoutView } from './workout.js';
import './workout.css';

const FAVICONS = Object.freeze({ open: '/favicon-workout.svg', reached: '/favicon-rest.svg' });

// The account's open workout on every gym page, whichever device started it (WD3.4, WD4.1): over the tab rail, one link
// back to it — the routine and the workout's clock, no device named — while its page is not shown. And, in the page's
// own head while the room is drawn, what stands in for a phone's Live Activity (WD2.5): the tab's title leads with the
// rest's clock, and the favicon carries a dot, brand once the rest reaches its target. Both are computed from the set
// times each time a timer fires, so they are right whenever they change, though a hidden tab's timers slow.
export function WorkoutBar({ onPage }) {
  const api = useGymApi();
  const read = useDomainRead(workoutView);
  const view = read.data;
  const [now, setNow] = useState(() => api?.now() ?? Date.now());
  useEffect(() => {
    if (!api || !view) return undefined;
    setNow(api.now());
    const timer = setInterval(() => setNow(api.now()), 1000);
    return () => clearInterval(timer);
  }, [api, Boolean(view)]);

  useEffect(() => {
    const before = document.title;
    return () => { document.title = before; };
  }, []);
  const title = view ? tabTitle(view, now) : t('gym.workout.roomTitle');
  useEffect(() => { document.title = title; }, [title]);

  const state = !view ? null : clocksAt(view, now).reached ? 'reached' : 'open';
  useEffect(() => {
    const icon = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    if (!icon || !state) return undefined;
    const before = icon.getAttribute('href');
    icon.setAttribute('href', FAVICONS[state]);
    return () => icon.setAttribute('href', before);
  }, [state]);

  if (!view || onPage) return null;
  return (
    <a className="gym-live-bar" href={WORKOUT_HREF} onClick={() => workoutStep('gym_hidden_workout', { action: 'open', door: 'bar' })}>
      <Dumbbell size={18} aria-hidden="true" />
      <span className="gym-live-bar-name">{view.name ?? t('gym.workout.untitled')}</span>
      <time className="gym-live-bar-clock" aria-label={t('gym.workout.barClock', { clock: clockOf(clocksAt(view, now).workoutMs) })}>
        {t('gym.workout.barClockShown', { clock: clockOf(clocksAt(view, now).workoutMs) })}
      </time>
    </a>
  );
}
