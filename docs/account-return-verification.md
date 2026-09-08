# Account return navigation verification

Connect and Settings share a Back action in both standalone and app-shell chrome. An unhandled
Escape invokes the same return action, including when a tool radio has focus. Text editing and
native selects retain Escape; dialogs and menus consume it before page navigation.

The shell records a known same-app predecessor in each history entry, preserving pathname,
query, and hash. Route replacements retain that metadata. Back uses browser history when the
predecessor is known; direct entry falls back to `/app` without leaving the app.

## Verified locally

- Connect → API keys → Manage keys opened Settings through the legacy hash link; Back returned
  to Connect.
- Direct entry to Connect, with the ChatGPT radio focused, returned to `/app` on Escape.
- Journal → account Settings retained `/app/journal` as the Back destination after reload.
- Escape closed an open account menu while remaining on Settings.
- Escape closed the sign-in dialog while remaining on Settings; the next Escape returned to Journal.
- Eighteen scoped tests passed across navigation, AccountSeat, Menu, and Connect. Navigation
  cases exercise full source URLs, nested account pages, native hash entries, pathname upgrades,
  reload metadata, browser back/forward, malformed/external predecessors, both chrome modes,
  focused radios, consumed events, editable fields, and native selects.
- Codex setup has an interaction regression asserting explicit `codex mcp login windmill` or
  Authenticate, browser approval, restart, `/mcp` inspection, and the official guide link.

`npm run build` passed all 1,734 tests with zero failures or skips, followed by the Vite and
landing-shell builds. Browser inspection also confirmed the Codex panel’s explicit login
instructions, official guide link, and Back control. These checks do not establish an external
Codex or ChatGPT OAuth handshake.

## Structure observations

Navigation metadata belongs to the shell, shared by ordinary route links, the room switcher,
and account chrome. Keeping the return action there avoids product-specific fallback logic or
component-local navigation histories. Connect and Settings supply neither a return hash nor
separate Escape handlers. Browser history retains responsibility for nested navigation.

The shared chrome builds one card in both display modes. Account menus and generic menus
consume Escape at the document level, so their priority does not depend on the order in which
page listeners mount. Client setup uses one optional guide link field rather than provider-specific
link markup.
