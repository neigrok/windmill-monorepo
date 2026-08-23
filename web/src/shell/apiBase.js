// In production the SPA and windmill_server share one host, so the base is empty and every request
// is relative. VITE_API_BASE_URL points a build elsewhere.

const configured = import.meta.env?.VITE_API_BASE_URL;

// An explicit empty string means same-origin; only an unset value falls back.
export const API_BASE = configured ?? (import.meta.env?.PROD ? '' : 'http://localhost:8088');

export function socketUrl() {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}/v1/socket`;
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/v1/socket`;
  }
  return 'ws://localhost:8088/v1/socket';
}
