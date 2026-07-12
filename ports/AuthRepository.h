#pragma once

#include "domain/Auth.h"
#include "domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// A magic link as stored, addressed by its digest: the email it signs in, whether it has
// been spent, and when it lapses. The raw token is never at rest.
struct StoredLink {
  Email email;
  bool consumed = false;
  UnixMs expiresAt = 0;
};

// A live session as stored: whose it is and when it lapses (rolled forward on each use).
struct StoredSession {
  UserId user;
  UnixMs expiresAt = 0;
};

// Persistence for accounts, magic links, and sessions — one connection per call, mirroring
// the other Postgres repositories. Digests, not secrets, are the keys throughout.
struct AuthRepository {
  virtual ~AuthRepository() = default;

  virtual std::optional<User> findUserByEmail(const Email& email) = 0;
  virtual std::optional<User> findUserById(const UserId& id) = 0;
  virtual User createUser(const Email& email, const std::string& name) = 0;

  virtual void insertLink(const std::string& digest, const Email& email, UnixMs createdAt,
                          UnixMs expiresAt) = 0;
  virtual int countRecentLinks(const Email& email, UnixMs since) = 0;
  virtual std::optional<StoredLink> findLink(const std::string& digest) = 0;
  // Spend the link atomically. Returns true only for the caller that actually flipped it
  // from unspent to spent — concurrent verifies of the same link get false, so exactly one
  // can mint a session (the "works once" guarantee, enforced at the row, not by the read).
  virtual bool consumeLink(const std::string& digest, UnixMs at) = 0;

  virtual void insertSession(const std::string& digest, const UserId& user, UnixMs expiresAt) = 0;
  virtual std::optional<StoredSession> findSession(const std::string& digest) = 0;
  virtual void refreshSession(const std::string& digest, UnixMs expiresAt) = 0;
  virtual void deleteSession(const std::string& digest) = 0;
};

}
