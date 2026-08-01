// How a training log reads — the pure rules behind the surface, with no React and no fetch in
// them: which session a URL names and how that URL is written, how a session is titled and timed,
// and the first-performed order its sets are grouped in. The phase-1 logger reads the same rules,
// and the tests read them without a browser.

// A position is a URL: #/gym is the log, #/gym/session/ses_… is one session. Reading and writing
// that one grammar live together, so a link and the parse that answers it can never drift — the
// logger will write it to walk into the session it just started.
export function sessionIdOf(hash) {
  const match = /^#\/gym\/session\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sessionHref(id) {
  return `#/gym/session/${id}`;
}

export function dayLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function whenLabel(ms) {
  return `${dayLabel(ms)} · ${timeLabel(ms)}`;
}

export function durationLabel(startedAt, finishedAt) {
  const minutes = Math.max(1, Math.round((finishedAt - startedAt) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function setCountLabel(count) {
  return count === 1 ? '1 set' : `${count} sets`;
}

// A session is over when the server says it has an end instant — and only then. Zero is an
// instant like any other, so this asks for absence rather than truthiness.
export function isFinished(session) {
  return session.finishedAt != null;
}

// The plan is the snapshot frozen at start; its routine name is the one field this surface reads.
// An ad-hoc session has no plan and is titled by what was actually lifted. The wire may carry the
// snapshot either already parsed or as the stored json string, and both mean the same thing.
export function routineNameOf(session) {
  if (!session.plan) return null;
  if (typeof session.plan === 'string') {
    try { return JSON.parse(session.plan).routine ?? null; } catch { return null; }
  }
  return session.plan.routine ?? null;
}

// First-performed order falls out of Map insertion order over sets sorted by completion; inside an
// exercise the server-assigned number is the order. A set the server has not numbered yet is one
// the logger is still flushing — it is the newest thing in that exercise, so it sorts last, and
// two of them fall back to when they happened. Without that floor the comparator returns NaN and
// the order of a session being logged is whatever the sort implementation happens to do.
export function groupByExercise(sets) {
  const groups = new Map();
  for (const set of [...sets].sort((a, b) => a.completedAt - b.completedAt)) {
    if (!groups.has(set.exerciseId)) groups.set(set.exerciseId, []);
    groups.get(set.exerciseId).push(set);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const left = a.setNumber ?? Number.MAX_SAFE_INTEGER;
      const right = b.setNumber ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.completedAt - b.completedAt;
    });
  }
  return [...groups.entries()];
}
