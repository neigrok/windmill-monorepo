#pragma once

#include "platform/domain/Auth.h"
#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// Addressed by its digest; the raw token is never at rest.
struct StoredLink {
  Email email;
  bool consumed = false;
  UnixMs expiresAt = 0;
  std::string forkSource;  // tree to fork into the account this link signs in; empty = plain link
};

// The link row seen through its code credential; linkDigest is the row's primary key.
struct StoredSignInCode {
  std::string linkDigest;
  std::string codeDigest;
  std::string forkSource;
};

struct StoredSession {
  UserId user;
  UnixMs expiresAt = 0;
};

// `id` is the public handle the revoke endpoint addresses; `tokenHash` never leaves this layer.
// userAgent/ip are raw. lastSeenMs 0 means unset — the service coalesces it to createdAtMs.
struct SessionRow {
  std::string id;
  std::string tokenHash;
  std::string userAgent;
  UnixMs lastSeenMs = 0;
  UnixMs createdAtMs = 0;
  std::string ip;
};

// Digests, not secrets, are the keys throughout.
struct AuthRepository {
  virtual ~AuthRepository() = default;

  virtual std::optional<User> findUserByEmail(const Email& email) = 0;
  virtual std::optional<User> findUserById(const UserId& id) = 0;
  virtual User createUser(const Email& email, const std::string& name) = 0;
  virtual void updateName(const UserId& userId, const std::string& name) = 0;
  virtual void markUserDeleted(const UserId& userId, UnixMs now) = 0;
  virtual void reviveUser(const UserId& userId) = 0;
  // Hard delete; only for the link merge, whose precondition is an account proven empty.
  virtual void deleteUser(const UserId& userId) = 0;

  // Keyed by the provider's subject, never by an address.
  virtual std::optional<UserId> findIdentity(Provider provider, const std::string& subject) = 0;
  virtual void bindIdentity(Provider provider, const std::string& subject, const UserId& userId,
                            const std::string& emailAtLink) = 0;
  // Every door of `from` opens `to` afterwards. Only once `from` is provably empty.
  virtual void moveIdentities(const UserId& from, const UserId& to) = 0;

  // One row carries both credentials: the link digest (the key) and its 6-digit code twin's.
  // Either burns the row through the same consumed_ms flip.
  virtual void insertLink(const std::string& digest, const std::string& codeDigest,
                          const Email& email, UnixMs createdAt, UnixMs expiresAt,
                          const std::string& forkSource) = 0;
  virtual int countRecentLinks(const Email& email, UnixMs since) = 0;
  virtual std::optional<StoredLink> findLink(const std::string& digest) = 0;
  // Newest row by address, and only while live: unspent, unexpired, under maxAttempts.
  virtual std::optional<StoredSignInCode> findLiveCode(const Email& email, UnixMs now,
                                                       int maxAttempts) = 0;
  // Atomic increment gated at the row, so racing verifies cannot lose one or pass the cap.
  // Returns the new count, or 0 when nothing matched: the row is spent or already guessed out.
  virtual int spendCodeAttempt(const std::string& digest, int maxAttempts) = 0;
  // Returns true only for the caller that flipped it unspent→spent, so exactly one mints a session.
  virtual bool consumeLink(const std::string& digest, UnixMs at) = 0;

  virtual void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt,
                             const std::string& userAgent, const std::string& ip, UnixMs seenAt) = 0;
  virtual std::optional<StoredSession> findSession(const std::string& digest) = 0;
  // Rolls the window forward, stamps last_seen, and heals user_agent/ip when non-empty
  // (empty leaves the stored value).
  virtual void refreshSession(const std::string& digest, UnixMs expiresAt, UnixMs seenAt,
                              const std::string& userAgent, const std::string& ip) = 0;
  virtual void deleteSession(const std::string& digest) = 0;

  // Most-recent first.
  virtual std::vector<SessionRow> listSessions(const UserId& userId) = 0;
  // Scoped to the owner, so a foreign id matches nothing. Returns the deleted row's digest,
  // or nullopt when nothing matched.
  virtual std::optional<std::string> revokeSession(const UserId& userId, const std::string& sessionId) = 0;
  // Drops every session but the one whose digest is kept.
  virtual void revokeSessionsExcept(const UserId& userId, const std::string& keepDigest) = 0;
  virtual void revokeAllSessions(const UserId& userId) = 0;
};

}
