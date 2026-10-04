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

// Capability segments become placeholders; query strings and fragments are omitted.
std::string redactedPath(const std::string& path);
std::string privacySafeLogBody(const std::string& body, const std::string& source);
std::string privacySafeLogSource(const std::string& source);

}
