// The one place the app resolves where its backend lives. In production the API is same-origin —
// the SPA and windmill_server share one host, path-routed by Caddy — so the base is empty and every
// request is same-origin-relative (and the collab socket derives ws(s):// from the page). A build
// can still point elsewhere with VITE_API_BASE_URL (e.g. a preview against a remote backend); local
// `npm run dev` falls back to the dev backend port.

const configured = import.meta.env?.VITE_API_BASE_URL;

// An explicit empty string is a deliberate same-origin choice — keep it; only an unset value falls
// back (to same-origin in a production build, to the dev backend port otherwise).
export const API_BASE = configured ?? (import.meta.env?.PROD ? '' : 'http://localhost:8088');

// The collab socket's URL. A non-empty base swaps its http(s) scheme for ws(s); a same-origin base
// derives scheme + host from the page; outside a browser (tests) it's the dev backend.
export function socketUrl() {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}/v1/socket`;
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/v1/socket`;
  }
  return 'ws://localhost:8088/v1/socket';
}
