#pragma once

#include <cstdint>
#include <cstdlib>
#include <string>

namespace wm {

// The replay window every vendor webhook in this codebase holds itself to, stated once: a delivery
// signed further than this from now is a capture being replayed.
//
// `timestamp` is the vendor's unix SECONDS exactly as it arrived, and is a signed field in both
// schemes. Empty, non-numeric, or long enough to overflow the millisecond conversion is not fresh.
// toleranceMs 0 skips the drift check (tests only) but never the shape check.
inline bool signedWithinWindow(const std::string& timestamp, std::int64_t nowMs,
                               std::int64_t toleranceMs) {
  if (timestamp.empty() || timestamp.size() > 12) return false;
  for (char c : timestamp)
    if (c < '0' || c > '9') return false;
  if (toleranceMs <= 0) return true;

  const std::int64_t signedAtMs = std::strtoll(timestamp.c_str(), nullptr, 10) * 1000;
  const std::int64_t drift = nowMs > signedAtMs ? nowMs - signedAtMs : signedAtMs - nowMs;
  return drift <= toleranceMs;
}

}
