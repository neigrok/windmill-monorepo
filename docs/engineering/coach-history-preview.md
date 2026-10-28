# Coach history answer preview

History pages expose optional `answerPreview` from the latest completed nonempty assistant turn.
The PostgreSQL projection returns at most 240 Unicode code points, preserving raw text and
Markdown. An empty completed answer, stopped answer, failed answer or running generation cannot
replace an earlier qualifying answer. No qualifying answer means the JSON field is omitted.

The existing bounded page query owns the projection, with both thread and owner predicates. It
uses turn position rather than timestamps and keeps full turns out of list responses. Existing
outcome derivation, receipts, pagination, persistence and sync schemas remain unchanged. The
simplification pass keeps this read in the existing repository and serializer without a second
endpoint, request per conversation, summary generator or new abstraction.

## Verification

The full ten-target no-database CTest gate passes. Its four C++ suites report 3296/4757 passing
cases and 1461 explicit skips: domain 28, MCP 119, sync 759 and adapters 555. After the final test
fixture adjustments, the complete adapters suite passes again with the same skip accounting.

With isolated PostgreSQL databases, domain passes 2276/2304, MCP 340/340, sync 765/765 and adapters
1348/1348: 4729 passing cases, zero failures and 28 domain skips. Those skips are 27 client-role
corpus files and one optional pattern-fuzz input; no PostgreSQL case is skipped. The nine-case
epoch tool check passes on an isolated repeat. Its earlier crash/retry attempt encountered a local
row-lock timeout after terminating the client; the unchanged tool/test is not claimed fixed.

The three added cases cover a multibyte 240-code-point boundary, raw Markdown/whitespace, latest
turn order despite older timestamps, empty and noncompleted answers, tied cursor pages, foreign
owners and a mismatched-owner turn. Full page JSON is asserted through the HTTP handler over
PostgreSQL. Existing full summary assertions include the additive preview while retaining all
receipt/outcome checks.

Nine live HTTP checks pass against the separately built server: authentication, exact paged and
legacy JSON, Unicode/state selection, empty omission, owner isolation, foreign/absent equivalence,
unchanged full-answer detail, an injected projection failure and content-free diagnostics. The
failure returns a generic 500 and records only the static route and compiled exception type.
No answer, credential or raw SQL error appears in the server log. Sentry is disabled locally, so
hosted Issue delivery is not claimed. Android history-step events belong to the client portion
of task 37; this read adds no mutation or event.

Verification and Android native acceptance use the separately built `backend/build-history-preview`
server. The original shared `backend/build` server remains unchanged. Temporary servers and
databases are removed after their acceptance run. The private evidence packet contains
the exact source manifest, test logs, HTTP assertions, binary hashes and cleanup proof. This
backend patch is retained for the single task 37 commit; no deployment or schema cutoff is claimed.
