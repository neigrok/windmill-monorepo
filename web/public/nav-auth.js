// Reflect the visitor's auth state in the static pages' nav (pricing, terms, refunds, privacy,
// changelog, connect). These are plain HTML — no React, no AuthProvider — so on their own they
// always showed "Log in", even to someone already signed in.
//
// The flash-free core runs INLINE in each page's <head>: it reads the same localStorage hint the
// app writes (windmill:auth-hint) and stamps <html data-auth="in|out"> before first paint, and a
// tiny CSS rule shows only the matching nav variant. This deferred pass then fills the account
// name from the hint and confirms with the server, correcting the nav — and the hint — if the
// hinted state turned out stale (signed out elsewhere, or a session that has since expired).
(function () {
  var root = document.documentElement;

  function hintUser() {
    try {
      var h = JSON.parse(localStorage.getItem('windmill:auth-hint') || 'null');
      if (h && h.status === 'signed-in' && h.user) return h.user;
    } catch (e) { /* absent or malformed — treat as signed out */ }
    return null;
  }

  function paint(user) {
    root.setAttribute('data-auth', user ? 'in' : 'out');
    var nameEl = document.querySelector('[data-authname]');
    if (nameEl && user) nameEl.textContent = user.name || 'My account';
  }

  function remember(user) {
    try {
      localStorage.setItem('windmill:auth-hint',
        JSON.stringify(user ? { status: 'signed-in', user: user } : { status: 'ghost' }));
    } catch (e) { /* storage unavailable — the hint is never load-bearing */ }
  }

  paint(hintUser()); // data-auth was already set inline pre-paint; this fills the name

  fetch('/v1/me', { credentials: 'include' }).then(function (r) {
    if (r.status === 401) { paint(null); remember(null); return null; } // a real "no session"
    if (!r.ok) return null;                                             // a blip — leave the hint alone
    return r.json();
  }).then(function (body) {
    if (!body) return;
    var user = body.user || null;
    paint(user);
    remember(user);
  }).catch(function () { /* unreachable — keep the hinted state */ });
})();
