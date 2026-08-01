#pragma once

#include "platform/domain/Auth.h"
#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A magic link as stored, addressed by its digest: the email it signs in, whether it has
// been spent, and when it lapses. The raw token is never at rest.
struct StoredLink {
  Email email;
  bool consumed = false;
  UnixMs expiresAt = 0;
  std::string forkSource;  // tree to fork into the account this link signs in; empty = plain link
};

// A live session as stored: whose it is and when it lapses (rolled forward on each use).
struct StoredSession {
  UserId user;
  UnixMs expiresAt = 0;
};

// One row of the settings §5 "Sessions & devices" list. `id` is the public handle the revoke
// endpoint addresses; `tokenHash` is the private digest, carried so the service can flag the
// caller's own current session and never leaves this layer. user_agent/ip are raw (the client
// formats device/place). lastSeenMs is the raw column — 0 for a pre-migration row, which the
// service coalesces to createdAtMs.
struct SessionRow {
  std::string id;
  std::string tokenHash;
  std::string userAgent;
  UnixMs lastSeenMs = 0;
  UnixMs createdAtMs = 0;
  std::string ip;
};

// Persistence for accounts, magic links, and sessions — one connection per call, mirroring
// the other Postgres repositories. Digests, not secrets, are the keys throughout.
struct AuthRepository {
  virtual ~AuthRepository() = default;

  virtual std::optional<User> findUserByEmail(const Email& email) = 0;
  virtual std::optional<User> findUserById(const UserId& id) = 0;
  virtual User createUser(const Email& email, const std::string& name) = 0;
  virtual void updateName(const UserId& userId, const std::string& name) = 0;
  // The settings §4 soft close and its undo: stamp / clear users.deleted_at.
  virtual void markUserDeleted(const UserId& userId, UnixMs now) = 0;
  virtual void reviveUser(const UserId& userId) = 0;
  // The row itself, gone. Reserved for the link merge, whose whole precondition is an account
  // proven to hold nothing — every other close in the product is the soft one above.
  virtual void deleteUser(const UserId& userId) = 0;

  // Provider doors (backend/AUTH.md, "Identities"). Keyed by the provider's subject, never by an
  // address, so a rotated relay or a moved primary email still opens the same account.
  virtual std::optional<UserId> findIdentity(Provider provider, const std::string& subject) = 0;
  virtual void bindIdentity(Provider provider, const std::string& subject, const UserId& userId,
                            const std::string& emailAtLink) = 0;
  // The merge: every door of `from` now opens `to`. Called only once `from` is provably empty.
  virtual void moveIdentities(const UserId& from, const UserId& to) = 0;

  virtual void insertLink(const std::string& digest, const Email& email, UnixMs createdAt,
                          UnixMs expiresAt, const std::string& forkSource) = 0;
  virtual int countRecentLinks(const Email& email, UnixMs since) = 0;
  virtual std::optional<StoredLink> findLink(const std::string& digest) = 0;
  // Spend the link atomically. Returns true only for the caller that actually flipped it
  // from unspent to spent — concurrent verifies of the same link get false, so exactly one
  // can mint a session (the "works once" guarantee, enforced at the row, not by the read).
  virtual bool consumeLink(const std::string& digest, UnixMs at) = 0;

  virtual void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                             const std::string& userAgent, const std::string& ip, UnixMs seenAt) = 0;
  virtual std::optional<StoredSession> findSession(const std::string& digest) = 0;
  // Roll the window forward on use, stamp last_seen with now, and heal user_agent/ip from the
  // request when it carries them (empty leaves the stored value) — so a pre-migration row
  // fills its metadata in the first time it is used.
  virtual void refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                              const std::string& userAgent, const std::string& ip) = 0;
  virtual void deleteSession(const std::string& digest) = 0;

  // The settings §5 sessions list, most-recent first.
  virtual std::vector<SessionRow> listSessions(const UserId& userId) = 0;
  // Revoke one of the user's sessions by its public id, scoped to the owner so a foreign id
  // matches nothing. Returns the deleted row's digest — so the caller can tell it just dropped
  // its own current session and must clear the cookie — or nullopt when nothing matched (a 404).
  virtual std::optional<std::string> revokeSession(const UserId& userId, const std::string& sessionId) = 0;
  // "Sign out everywhere": drop every session but the one whose digest is kept (the caller's own).
  virtual void revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) = 0;
  // Account close: drop every session the user has, this device included.
  virtual void revokeAllSessions(const UserId& userId) = 0;
};

}
