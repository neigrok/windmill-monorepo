#pragma once

#include "platform/domain/Ids.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace wm {

// Wall-clock milliseconds since the Unix epoch, matching Clock::nowMs().
using UnixMs = std::uint64_t;

// Syntactically valid and normalized: trimmed, lowercased. parseEmail is the only constructor.
struct Email {
  std::string value;
  bool operator==(const Email&) const = default;
};
std::optional<Email> parseEmail(const std::string& raw);

// `deletedAt` is the soft-close stamp: set while the grace runs, cleared when a magic link signs
// the account back in.
struct User {
  UserId id;
  Email email;
  std::string name;
  std::optional<UnixMs> deletedAt;
};
std::string nameFromEmail(const Email& email);

// The name strangers may see; empty when the stored name is only derived from the address.
std::string sharableName(const User& user);

// A trimmed, non-empty display name within the length cap; nullopt when blank or too long.
std::optional<std::string> parseName(const std::string& raw);

struct AuthPolicy {
  static constexpr UnixMs linkLifetimeMs = 15ull * 60 * 1000;
  static constexpr UnixMs sessionLifetimeMs = 90ull * 24 * 60 * 60 * 1000;
  static constexpr UnixMs rateWindowMs = 10ull * 60 * 1000;
  static constexpr int maxLinksPerWindow = 9;
  // The typed code shares the link row's lifetime and single use; maxCodeAttempts is its defense,
  // not the digest at rest.
  static constexpr int codeLength = 6;
  static constexpr int maxCodeAttempts = 5;
  static constexpr std::size_t nameMaxBytes = 80;
  static constexpr UnixMs closeGraceMs = 30ull * 24 * 60 * 60 * 1000;
};

inline bool withinRateLimit(int recentLinks) { return recentLinks < AuthPolicy::maxLinksPerWindow; }

inline bool nameWithinLimit(const std::string& trimmed) {
  return !trimmed.empty() && trimmed.size() <= AuthPolicy::nameMaxBytes;
}

inline UnixMs linkExpiry(UnixMs now) { return now + AuthPolicy::linkLifetimeMs; }
inline UnixMs sessionExpiry(UnixMs now) { return now + AuthPolicy::sessionLifetimeMs; }
inline bool sessionExpired(UnixMs expiresAt, UnixMs now) { return now >= expiresAt; }

// The instant a close becomes final.
inline UnixMs closesAt(UnixMs deletedAt) { return deletedAt + AuthPolicy::closeGraceMs; }

// A last_seen of 0 means unset; the creation stamp stands in for it.
inline UnixMs effectiveLastSeen(UnixMs lastSeenMs, UnixMs createdMs) {
  return lastSeenMs == 0 ? createdMs : lastSeenMs;
}

enum class LinkVerdict { valid, expired, alreadyUsed, unknown };
LinkVerdict verifyLink(bool found, bool consumed, UnixMs expiresAt, UnixMs now);

// Only wrongCode spends an attempt. At the edge every non-valid verdict must collapse to one
// identical refusal, so nothing leaks about which addresses hold pending codes.
enum class CodeVerdict { valid, wrongCode, noLiveCode };
CodeVerdict verifyCode(bool foundLive, bool matches);

// The stored spelling is the `provider` column's check constraint.
enum class Provider { google, apple };
std::string toString(Provider provider);
std::optional<Provider> parseProvider(std::string_view raw);

// `subject` is the provider-issued stable key for this app: it never renders, and it is the only
// field that may resolve an account on its own. `name` only seeds a new account, never overwrites
// one.
struct ProviderIdentity {
  Provider provider = Provider::google;
  std::string subject;
  Email email;
  std::string name;
  bool emailVerified = false;
  bool relayEmail = false;  // the provider said so itself (Apple's is_private_email)
};

// Apple's Hide My Email: tested on the published suffix, behind the provider's own claim.
bool isPrivateRelay(const Email& email);

// How far a provider's address can be trusted to name the human:
//   crossDoor — verified and real; resolves an account made through any other door
//   appOnly   — a relay: re-finds the same person here only
//   unusable  — unverified or unparseable; must not touch an account at all
enum class AddressTrust { crossDoor, appOnly, unusable };
AddressTrust trustOf(const ProviderIdentity& identity);

}
