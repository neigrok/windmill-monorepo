#pragma once

#include <string>

namespace wm {

// The shared vocabulary of the inbound access log (AccessLog.h) and the outbound vendor call (VendorCall.h).
enum class Severity { info, warn, error };

// 5xx is ours to fix, 4xx is a refusal worth seeing and not worth paging, the rest is traffic.
Severity severityForStatus(int status);

// One decimal millisecond. A negative duration renders "?" rather than a plausible zero.
std::string tookMs(long long micros);

// Percent-encode anything a caller can steer before it reaches a log line: drogon URL-DECODES the
// path, so a raw newline in it would otherwise split one request into two physical lines. Also
// capped, and says so where it cuts, because the line is teed to Sentry as an event body.
std::string loggableField(const std::string& value);

// The path with any capability secret in it cut to a short prefix — useless as a credential, long
// enough to tie two reads of one link together. A table: /v1/gym/shared is the only route today
// whose PATH carries a secret; every other rides the query string, which the access line drops.
std::string redactedPath(const std::string& path);

}
