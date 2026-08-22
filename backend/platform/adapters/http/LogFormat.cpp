#include "platform/adapters/http/LogFormat.h"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <string_view>

namespace wm {

namespace {
constexpr char kHexDigits[] = "0123456789ABCDEF";

// The routes whose NEXT path segment is a live credential. One entry today; the table is the point.
constexpr std::string_view kSecretSegmentAfter[] = {"/v1/gym/shared/"};

// Enough of the secret to correlate two reads of the same link in one log, far too little to use as
// one: the coach token is 43 base64 characters, so 35 of them stay unsaid.
constexpr std::size_t kKeptSecretPrefix = 8;

// A logged field is a debugging aid, not a transcript. A path is caller-supplied and unbounded, and
// this line is teed to Sentry as an event body — so an anonymous request with a 60 KB path was a 60
// KB log line and a 60 KB event, for free, as often as it liked. What is cut is said out loud.
constexpr std::size_t kMaxLoggedField = 1024;
constexpr std::string_view kTruncated = "~truncated";
}

Severity severityForStatus(int status) {
  if (status >= 500) return Severity::error;
  if (status >= 400) return Severity::warn;
  return Severity::info;
}

std::string tookMs(long long micros) {
  if (micros < 0) return "?";
  return std::to_string(micros / 1000) + "." + std::to_string((micros % 1000) / 100);
}

std::string loggableField(const std::string& value) {
  std::string safe;
  safe.reserve(std::min(value.size(), kMaxLoggedField));
  for (const unsigned char byte : value) {
    // Measured on the ENCODED length, because a field of control bytes triples on the way through.
    if (safe.size() >= kMaxLoggedField) {
      safe.append(kTruncated);
      break;
    }
    if (byte >= 0x20 && byte != 0x7f) {
      safe.push_back(static_cast<char>(byte));
      continue;
    }
    safe.push_back('%');
    safe.push_back(kHexDigits[byte >> 4]);
    safe.push_back(kHexDigits[byte & 0x0f]);
  }
  return safe;
}

std::string redactedPath(const std::string& path) {
  // Matched on a lowercased copy and spliced back out of the original by index. Drogon ROUTES
  // case-insensitively while path() preserves what the caller typed, so a case-sensitive match here
  // would have let `GET /V1/GYM/SHARED/<token>` serve the workout AND log the working token — the
  // same trap the rate limiter documents at main.cpp, defeated by one capital letter.
  std::string folded = path;
  std::transform(folded.begin(), folded.end(), folded.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

  for (const std::string_view prefix : kSecretSegmentAfter) {
    if (folded.rfind(prefix, 0) != 0) continue;
    const std::size_t secret = prefix.size();
    const std::size_t after = std::min(folded.find('/', secret), path.size());
    if (after == secret) continue;  // the prefix with no segment behind it carries no secret
    // The prefix is spliced from the ORIGINAL, so the line still says what was actually requested.
    return path.substr(0, secret) + path.substr(secret, std::min(kKeptSecretPrefix, after - secret)) +
           "~redacted" + path.substr(after);
  }
  return path;
}

}
