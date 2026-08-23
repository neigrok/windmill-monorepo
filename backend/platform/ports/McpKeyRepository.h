#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// `scope` is in the same wire spelling OAuth uses; every key is minted account-wide (scope '').
struct ActiveKey {
  UserId user;
  std::string scope;
  std::string id;
  std::string name;
};

// `id` is the public handle the revoke endpoint addresses; lastUsedMs is null until first use.
// The token digest never leaves the persistence layer.
struct McpKeyRow {
  std::string id;
  std::string name;
  long long createdMs = 0;
  std::optional<long long> lastUsedMs;
};

// A key is addressed by the digest of its token and only ever stored as that digest.
struct McpKeyRepository {
  virtual ~McpKeyRepository() = default;

  // Returns the generated public id (uuid text).
  virtual std::string insert(const std::string& tokenDigest, const UserId& user,
                             const std::string& name, long long createdMs) = 0;

  // Newest first, without the token.
  virtual std::vector<McpKeyRow> list(const UserId& user) = 0;

  // Scoped to the owner, so a foreign id matches nothing. True only when a row was deleted.
  virtual bool revoke(const UserId& user, const std::string& id) = 0;

  // Only an unexpired key whose account is not soft-closed; nullopt otherwise.
  virtual std::optional<ActiveKey> findActiveKey(const std::string& tokenDigest, long long nowMs) = 0;

  // Advances the last-used stamp only past throttleMs.
  virtual void touchUsed(const std::string& tokenDigest, long long nowMs, long long throttleMs) = 0;
};

}
