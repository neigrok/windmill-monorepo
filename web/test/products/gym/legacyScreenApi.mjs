import { API_BASE } from '../../../src/shell/apiBase.js';
import { GymError, gymApi } from '../../../src/products/gym/gymApi.js';

// Existing screen fixtures describe the rendered REST response shape. Only tests use this wire.
async function request(path, method = 'GET', body, optional = false) {
  const response = await fetch(`${API_BASE}/v1/gym${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (optional && response.status === 404 || response.status === 204) return null;
  const value = await response.json();
  if (!response.ok) throw new GymError(response.status, value.error ?? '', value.code ?? '', value);
  return value;
}
const query = (values) => {
  const suffix = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== ''));
  return suffix.size ? `?${suffix}` : '';
};
const collection = (path, key) => async () => (await request(path))[key];
const entity = (path) => async (id) => request(`${path}/${encodeURIComponent(id)}`, 'GET', undefined, true);
const remove = (path) => async (id) => request(`${path}/${encodeURIComponent(id)}`, 'DELETE');

export const screenApi = {
  ...gymApi, ready: true,
  exercises: collection('/exercises', 'exercises'),
  lastSets: collection('/exercises/last', 'movements'),
  createExercise: (body) => request('/exercises', 'POST', body),
  renameExercise: (id, name) => request(`/exercises/${id}`, 'PATCH', { name }),
  record: (id) => request(`/exercises/${id}/record`, 'GET', undefined, true),
  sessions: async (values = {}) => (await request(`/sessions${query(values)}`)).sessions,
  session: entity('/sessions'),
  review: (id) => request(`/sessions/${id}/review`),
  discardSession: remove('/sessions'),
  fixSet: (session, id, body) => request(`/sessions/${session}/sets/${id}`, 'PATCH', body),
  deleteSet: (session, id) => request(`/sessions/${session}/sets/${id}`, 'DELETE'),
  importSession: (body) => request('/sessions/import', 'POST', body),
  correctSession: (id, body) => request(`/sessions/${id}/corrections`, 'POST', body),
  lastTime: (exercise) => request(`/last${query({ exercise })}`),
  history: (values = {}) => request(`/history${query(values)}`),
  progress: () => request('/stats?projection=progress'),
  routines: collection('/routines', 'routines'),
  routine: entity('/routines'),
  createRoutine: (body) => request('/routines', 'POST', body),
  replaceRoutine: (id, body) => request(`/routines/${id}`, 'PUT', body),
  deleteRoutine: remove('/routines'),
  proposal: entity('/proposals'),
  applyProposal: (id) => request(`/proposals/${id}/apply`, 'POST'),
  dismissProposal: (id) => request(`/proposals/${id}/dismiss`, 'POST'),
  notes: collection('/notes', 'notes'),
  saveNote: async (id, body) => (await request(`/notes/${id}`, 'PUT', body)).note,
  reorderNotes: async (order) => (await request('/notes', 'PUT', { order })).notes,
  deleteNote: remove('/notes'),
  bodyweight: () => request('/bodyweight'),
  saveBodyweight: async (id, { weightKg, recordedAt }) => (await request(`/bodyweight/${id}`, 'PUT', { weightKg, recordedAt })).entry,
  deleteBodyweight: remove('/bodyweight'),
  preferences: () => request('/preferences'),
  savePreferences: (body) => request('/preferences', 'PUT', body),
};
export function useGymApi() { return screenApi; }
export function gymStep() {}

export function prepareGymSync() {}
