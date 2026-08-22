#pragma once

#include <string>

namespace wm {

// The vocabulary both seams at the HTTP edge write in — the inbound access log (AccessLog.h) and
// the outbound vendor call (VendorCall.h). They exist to be read together in one stream, and an
// alert built on level alone only holds while they agree on what a level means, so they agree here
// rather than twice.

enum class Severity { info, warn, error };

// 5xx is ours to fix, 4xx is a refusal worth seeing and not worth paging, the rest is traffic. The
// same rule in both directions: a vendor answering us 500 and us answering a caller 500 are the
// same kind of bad night.
Severity severityForStatus(int status);

// One decimal millisecond. Whole milliseconds round a fast handler — or a fast vendor — to "0ms"
// and erase the difference between fast and free, which is where a regression shows first. A
// negative duration renders "?" rather than a plausible zero: an invented number in a latency log
// is worse than an admitted gap.
std::string tookMs(long long micros);

// Everything a caller can steer — a method, a path, a caller id — is percent-encoded here before it
// reaches a line. Drogon URL-DECODES the path, so a request for `/v1/sessions/x%0a…` arrives
// carrying a REAL newline: concatenated verbatim it split one request into two physical log lines,
// and an anonymous stranger could mint a byte-perfect `auth: account closed user=…` record in the
// log an incident is read from. Encoding rather than dropping keeps the line honest about what was
// actually asked for, and keeps it one line.
//
// It is also CAPPED, and says so where it cuts. A field is caller-supplied and unbounded while this
// line is teed to Sentry as an event body, so a 60 KB path bought a 60 KB log line and a 60 KB
// event for the price of one anonymous request.
std::string loggableField(const std::string& value);

// The path with any capability secret in it cut down to a prefix. A log is retained, replicated to
// Sentry and read by more people than a database is, so a secret that reaches it is a secret we
// gave away: GET /v1/gym/shared/{token} carries a live 256-bit coach-share credential as a path
// segment, and every coach link ever opened was logged as a working URL. The prefix is short enough
// to be useless as a credential and long enough to still tie two reads of one link together.
//
// It is a table rather than a gym special case: /v1/gym/shared is the only route today whose PATH
// carries a secret — every other secret this server takes rides the query string, which the access
// line already drops — and the next one should be one line here, not a second rule somewhere else.
std::string redactedPath(const std::string& path);

}
