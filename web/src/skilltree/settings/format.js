// The settings page's presentation formatters — pure, dependency-free, and the one
// testable seam in the settings package. A session row has no geo-IP, so place never
// renders; what we can say honestly is the device (from the user-agent string) and the
// recency (from a millisecond timestamp). Grants speak the same two dialects: a granted
// date and a last-active recency.

// A user-agent string → "Chrome on macOS", degrading a phrase at a time: browser + OS,
// else whichever half we recognise, else "Unknown device". Order is load-bearing — Edge,
// Opera and Brave all carry "Chrome" in their UA, and Safari carries "Safari" that Chrome
// also carries, so the more specific token is tested first.
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

// A past millisecond timestamp → a calm recency: "just now", "5m ago", "3h ago", "2d ago",
// then a plain date once it is more than a week old. Matches the switcher's "2h ago" voice.
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

// A millisecond timestamp → "Aug 16, 2026". Used for grant dates and the account-closing chip.
export function shortDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// An MCP key's meta line: when it was minted, and how recently it last authenticated — a
// fresh key reads "never used" until its first call. Composes the same two dialects the
// session and grant rows speak.
export function mcpKeyMeta(key) {
  const used = key.lastUsedMs ? `Last used ${relativeTime(key.lastUsedMs)}` : 'never used';
  return `Created ${shortDate(key.createdMs)} · ${used}`;
}
