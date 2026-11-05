import { API_BASE } from '../../../shell/apiBase.js';
import { reportUnexpectedFailure } from '../reportFailure.js';

// Null on a miss, whatever kind. A request lost while someone watched and a server failure report; a refusal does not.
async function tendRequest(path, init) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  } catch (error) {
    reportUnexpectedFailure('roadmap-tend', Object.assign(error, { status: 0 }));
    return null;
  }
  if (!response.ok) {
    reportUnexpectedFailure('roadmap-tend', { status: response.status });
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    reportUnexpectedFailure('roadmap-tend', error);
    return null;
  }
}

// { enabled, plan, limit, used, remaining, resetAtMs, runs[] }
export function fetchTending() {
  return tendRequest('/v1/tending');
}

// 202 { runId } for a started run, 200 { status:'refused', refusal } for a refusal; null on a miss.
export function startTend(treeId, prompt) {
  return tendRequest(`/v1/trees/${encodeURIComponent(treeId)}/tend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

// The run by id, however long after the socket that started it died. Null on a miss.
export function fetchRun(runId) {
  return tendRequest(`/v1/tend/${encodeURIComponent(runId)}`);
}
