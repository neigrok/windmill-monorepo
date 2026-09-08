export function rememberHashNavigation(event) {
  const href = window.location.pathname + window.location.search + window.location.hash;
  const entry = window.history.state?.windmillNavigation;
  if (entry?.href === href) return;
  const source = event?.oldURL ? new URL(event.oldURL) : null;
  const previous = source?.origin === window.location.origin
    ? source.pathname + source.search + source.hash : null;
  window.history.replaceState({ ...window.history.state, windmillNavigation: { href, previous } }, '', href);
}

export function replaceLocation(href) {
  const url = new URL(href, window.location.href);
  const path = url.pathname + url.search + url.hash;
  const previous = window.history.state?.windmillNavigation?.previous ?? null;
  window.history.replaceState({ ...window.history.state, windmillNavigation: { href: path, previous } }, '', url.href);
}

export function navigate(href, { replace = false } = {}) {
  if (replace) {
    replaceLocation(href);
  } else {
    rememberHashNavigation();
    const previous = window.location.pathname + window.location.search + window.location.hash;
    const url = new URL(href, window.location.href);
    const path = url.pathname + url.search + url.hash;
    if (path === previous) return;
    window.history.pushState({ windmillNavigation: { href: path, previous } }, '', url.href);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function previousLocation() {
  const href = window.location.pathname + window.location.search + window.location.hash;
  const entry = window.history.state?.windmillNavigation;
  if (entry?.href !== href || typeof entry.previous !== 'string') return null;
  if (!entry.previous.startsWith('/')) return null;
  try {
    const previous = new URL(entry.previous, window.location.href);
    if (previous.origin !== window.location.origin) return null;
    return previous.pathname + previous.search + previous.hash;
  } catch {
    return null;
  }
}

export function returnToPreviousLocation() {
  if (previousLocation()) {
    window.history.back();
    return;
  }
  navigate('/app', { replace: true });
}
