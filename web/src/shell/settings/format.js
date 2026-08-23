// Test order is load-bearing: Edge, Opera and Brave all carry "Chrome", and Chrome carries
// "Safari", so the more specific token is tested first.
export function formatUserAgent(userAgent) {
  const ua = String(userAgent ?? '');
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (browser && os) return `${browser} on ${os}`;
  if (os) return os;
  if (browser) return browser;
  return 'Unknown device';
}

function browserOf(ua) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '';
}

function osOf(ua) {
  if (/iPhone/.test(ua)) return 'iOS';
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

export function relativeTime(ms) {
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(ms);
}

export function shortDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function mcpKeyMeta(key) {
  const used = key.lastUsedMs ? `Last used ${relativeTime(key.lastUsedMs)}` : 'never used';
  return `Created ${shortDate(key.createdMs)} · ${used}`;
}
