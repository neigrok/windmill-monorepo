#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
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
// door). `name` seeds from the address and is editable later in settings. `deletedAt` is
// the settings §4 soft-close stamp: set while the 30-day grace runs, cleared the moment a
// magic link signs the account back in.
struct User {
  UserId id;
  Email email;
  std::string name;
  std::optional<UnixMs> deletedAt;
};
std::string nameFromEmail(const Email& email);

// The name strangers may see. A name we spliced out of an email address is not one anyone chose
// to publish — showing it on a public tree would hand every passer-by most of the address — so it
// reads as no name at all, and the surface that needs one names the visitor itself.
std::string sharableName(const User& user);

// The settings §5 profile edit: a trimmed, non-empty display name within the length cap.
// nullopt is the doc's "that name's blank, or too long" — the only two ways a rename fails.
std::optional<std::string> parseName(const std::string& raw);

// Every lifetime and limit, straight from guidelines/auth.md §3 and §8. One place so the
// copy ("15 minutes", "90-day rolling", "try again in 10 minutes") stays honest.
struct AuthPolicy {
  static constexpr UnixMs linkLifetimeMs = 15ull * 60 * 1000;
  static constexpr UnixMs sessionLifetimeMs = 90ull * 24 * 60 * 60 * 1000;
  static constexpr UnixMs rateWindowMs = 10ull * 60 * 1000;
  static constexpr int maxLinksPerWindow = 3;
  static constexpr std::size_t nameMaxBytes = 80;                  // settings §5 profile name cap
  static constexpr UnixMs closeGraceMs = 30ull * 24 * 60 * 60 * 1000;  // settings §4 delete grace
};

// "a few links in a row" — the request is honoured while fewer than the window's cap sit
// unspent; the next one is asked to wait.
inline bool withinRateLimit(int recentLinks) { return recentLinks < AuthPolicy::maxLinksPerWindow; }

// A trimmed name is accepted only when it says something and stays within the cap.
inline bool nameWithinLimit(const std::string& trimmed) {
  return !trimmed.empty() && trimmed.size() <= AuthPolicy::nameMaxBytes;
}

inline UnixMs linkExpiry(UnixMs now) { return now + AuthPolicy::linkLifetimeMs; }
inline UnixMs sessionExpiry(UnixMs now) { return now + AuthPolicy::sessionLifetimeMs; }
inline bool sessionExpired(UnixMs expiresAt, UnixMs now) { return now >= expiresAt; }

// The instant a close (stamped at `deletedAt`) becomes final — the 30-day grace's end, the
// date the "Account closing · {date}" chip shows and the undo window closes on.
inline UnixMs closesAt(UnixMs deletedAt) { return deletedAt + AuthPolicy::closeGraceMs; }

// A stored session's most recent activity: its last_seen stamp, or — for a row minted before
// the column existed and never refreshed since — the moment it was created.
inline UnixMs effectiveLastSeen(UnixMs lastSeenMs, UnixMs createdMs) {
  return lastSeenMs == 0 ? createdMs : lastSeenMs;
}

// A presented link resolves to exactly one of these. Expired and alreadyUsed share a
// remedy in the UI ("email me a fresh one"), but the server distinguishes them; unknown
// folds into the same remedy without leaking whether a digest ever existed.
enum class LinkVerdict { valid, expired, alreadyUsed, unknown };
LinkVerdict verifyLink(bool found, bool consumed, UnixMs expiresAt, UnixMs now);

}
