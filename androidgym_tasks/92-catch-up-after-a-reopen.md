# iOS and web catch up after a live socket reopens

**Status:** Not started. iOS and web engines; nothing visual changes.

**Context:** a change made between a client's reconnect pull and its new socket's subscription is missed until the next trigger or the fallback pull. Android pulls once after a reopen that follows a failure (2a0c88ff), and engine.md §7.5 says so. iOS and web do not. So a routine edited on the phone can take up to the fallback interval to appear on web, and the other way round.

**Current implementation**
- Android: the first open after a failed open or an ended socket sends one pull after its sub frames. A close the client makes reopens at once with no extra pull (`apps/android/sync-engine/…/SyncRuntime.kt`, 2a0c88ff).
- iOS pulls when an open fails or a socket ends (`reopenLater`, `apps/ios/Sync/Sources/SyncEngine/LiveChannel.swift:293-297`). A successful reopen (`open`, `.ok`, `:171-181`) does not pull.
- Web's `onopen` only subscribes again (`web/src/platform/sync/transport.js:78-85`). Its pull trigger `onReconnect` fires inside `ended()` (`:176`), before the reopen.

**Change**
- iOS and web send one catch-up pull after the subscription frames, on the first successful open that follows a failure or an ended socket. A close the client makes on purpose (re-identify, sign-in) reopens with no extra pull, as Android does.
- Add a conformance case, or a test per engine, that drops a socket, commits a change on the server before the reopen's sub, and expects it to arrive with no other trigger.

**Done when**
- The tests pass on Swift and web.
- On the local stack, with the live socket dropped and a routine edited over MCP before it reopens, the edit appears on web and on the iOS simulator within seconds of the reopen.

**Depends on:** none. Tree: `sync-catch-up-after-reopen-ios-web`.
