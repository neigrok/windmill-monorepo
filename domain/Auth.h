#pragma once

#include "domain/Ids.h"

#include <cstdint>
#include <optional>
#include <string>

namespace wm {

// Wall-clock milliseconds since the Unix epoch — the unit the auth lifetimes are counted
// in, matching Clock::nowMs(). Kept distinct from Hlc: sessions and links expire against
// real time, not logical time.
using UnixMs = std::uint64_t;

// A syntactically valid, normalized email address (trimmed, lowercased). Building one is
// the only gate before a link is sent, so parseEmail is the address's named constructor:
// nullopt is exactly the doc's "that address looks unfinished".
struct Email {
  std::string value;
  bool operator==(const Email&) const = default;
};
std::optional<Email> parseEmail(const std::string& raw);

// A signed-in account. Keyed by email; the row is minted on the first sign-in (§1, one
// door). `name` seeds from the address and is editable later in settings.
struct User {
  UserId id;
  Email email;
  std::string name;
};
std::string nameFromEmail(const Email& email);

// Every lifetime and limit, straight from guidelines/auth.md §3 and §8. One place so the
// copy ("15 minutes", "90-day rolling", "try again in 10 minutes") stays honest.
struct AuthPolicy {
  static constexpr UnixMs linkLifetimeMs = 15ull * 60 * 1000;
  static constexpr UnixMs sessionLifetimeMs = 90ull * 24 * 60 * 60 * 1000;
  static constexpr UnixMs rateWindowMs = 10ull * 60 * 1000;
  static constexpr int maxLinksPerWindow = 3;
};

// "a few links in a row" — the request is honoured while fewer than the window's cap sit
// unspent; the next one is asked to wait.
inline bool withinRateLimit(int recentLinks) { return recentLinks < AuthPolicy::maxLinksPerWindow; }

inline UnixMs linkExpiry(UnixMs now) { return now + AuthPolicy::linkLifetimeMs; }
inline UnixMs sessionExpiry(UnixMs now) { return now + AuthPolicy::sessionLifetimeMs; }
inline bool sessionExpired(UnixMs expiresAt, UnixMs now) { return now >= expiresAt; }

// A presented link resolves to exactly one of these. Expired and alreadyUsed share a
// remedy in the UI ("email me a fresh one"), but the server distinguishes them; unknown
// folds into the same remedy without leaking whether a digest ever existed.
enum class LinkVerdict { valid, expired, alreadyUsed, unknown };
LinkVerdict verifyLink(bool found, bool consumed, UnixMs expiresAt, UnixMs now);

}
