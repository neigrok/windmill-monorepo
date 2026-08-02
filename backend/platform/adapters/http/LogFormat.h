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

}
