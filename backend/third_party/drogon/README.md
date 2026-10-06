# Drogon, pinned and patched

Every build links Drogon 1.9.13 (commit `4c5430757ea5451a7c38fbbef4b4bef7dbb47f2f`, with the trantor
commit its submodule pins, `63a4e5e164e219dc3bf30cdbfa1462ae5602fa97`), built from the two GitHub
archives `drogon.cmake` names and checks by SHA-256, with the patches in `patches/` applied in order.
A patch that no longer applies fails the build.

`drogon.cmake` builds it once into a prefix and reuses it while the script (the pin and the build
options) and every patch's text stay the same; a prefix that holds another build is built again, and
deleting the prefix builds it again too, as after a major upgrade of a library Drogon links (jsoncpp,
OpenSSL). Two callers:

- `CMakeLists.txt` includes it at configure time, and a build dir configures again when a patch is
  added, removed or edited, so the next build builds the new Drogon. The prefix defaults to
  `~/.cache/windmill/drogon-<version>-<first 12 hex of the build's key>` (under `$XDG_CACHE_HOME` when
  set), shared by every checkout; `-DWM_DROGON_PREFIX=<dir>` puts it elsewhere.
- The `Dockerfile`'s builder copies in `drogon.cmake` and `patches/` alone and runs
  `cmake -DWM_DROGON_PREFIX=/opt/drogon -P drogon.cmake` in a layer of its own. Backend CI's layer
  cache keeps it until the pin, a patch, or a layer beneath it changes (a new `ubuntu:22.04` or its
  apt packages); this README is not in it. The configure after it finds the build in place.

## The patches

Each is a `git format-patch` file against the pinned release, with a message written for upstream.

- `0001` — the request keeps every header field line it was received with. `HttpRequest::headers()`
  keeps the first of a repeated name and folds `Cookie` into `cookies()`, where a later cookie of one
  name replaces an earlier one and a piece without `=` is dropped. `headerOccurrences()` lists every
  line the parser read, in order: each name as sent and the bytes after its colon. The pooled request
  clears the list in `reset()` and swaps it in `swap()`. The sync endpoints read §9.1's credentials
  from it (`platform/domain/sync/Credentials.h`).
- `0002` — a response keeps a cookie per name, domain and path (RFC 6265 §5.3), so it can set
  `wm_session` in one scope and expire it in others (`AuthApi.cpp`, engine.md §9.1 Session cookie
  scopes). `getCookie(name)` answers one cookie of the name and `removeCookie(name)` removes all.
- `0003` — a request whose field lines or framing RFC 9112 calls invalid is answered `400` and the
  connection closed, each of which upstream reads some other way: a line with no colon (upstream ends
  the header section there, so the lines after it begin the next request), a name that is empty or
  holds whitespace (a folded line, a space before the colon), a bare CR or LF, `Content-Length` sent
  twice or beside `Transfer-Encoding`, and a second `Transfer-Encoding` line, which always names a
  coding other than one final `chunked` (upstream frames by the first `Content-Length` or coding). A
  single `Transfer-Encoding` line naming another coding stays upstream's `501`. So an RFC 9112
  recipient in front of the server never frames a connection's requests otherwise than the server
  does.

`test/third_party/drogon/PatchesTest.cpp` pins all three against Drogon's own parser, on a loopback
connection in the test process. It also pins Trantor's listener-wide SIGPIPE protection: a closed
client's socket write cannot terminate the server. `test/e2e/http_disconnect_test.py` resets twelve
connections during large replies from the production server, checking it serves a read after each;
the deployment conformance runs it against both server compositions in CI.

## Moving to another Drogon

Change the two archives and their SHA-256s in `drogon.cmake` (the trantor commit is the one the new
release's `trantor` submodule pins), rebuild, and rebase any patch that fails. Upstreaming a patch:
`git am` it onto Drogon's `master`, open a pull request, and drop the file here once a pinned release
carries it.
