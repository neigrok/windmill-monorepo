#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A live key resolved from a presented secret: the account it acts as, the scope it was minted
// with — in the same wire spelling OAuth uses; v1 mints every key account-wide (scope ''), so the two
// credentials read alike and neither is the hole the other one closes — and the key's own public id
// and display name, which is how a tool tells one of the account's keys from another.
struct ActiveKey {
  UserId user;
  std::string scope;
  std::string id;
  std::string name;
};

// One row of the settings MCP-keys list: the public id the revoke endpoint addresses, the
// display name, when it was minted, and when it last authenticated a call (null until first
// use). The token digest — the private key of the row — never leaves the persistence layer.
struct McpKeyRow {
  std::string id;
  std::string name;
  long long createdMs = 0;
  std::optional<long long> lastUsedMs;
};

// Persistence for personal MCP API keys — one connection per call, mirroring the other
// Postgres repositories. Digests, not secrets, are the keys throughout: a key is addressed by
// the digest of its token and only ever stored as that digest.
struct McpKeyRepository {
  virtual ~McpKeyRepository() = default;

  // Insert a key row and return the generated public id (uuid text). The digest is the row's
  // primary key; the raw secret is never at rest.
  virtual std::string insert(const std::string& tokenDigest, const UserId& user,
                             const std::string& name, long long createdMs) = 0;

  // The user's keys, newest first, without the token.
  virtual std::vector<McpKeyRow> list(const UserId& user) = 0;

  // Revoke one key by its public id, scoped to the owner so a foreign id matches nothing.
  // True only when a row was actually deleted (a 404 otherwise).
  virtual bool revoke(const UserId& user, const std::string& id) = 0;

  // The live key a presented digest names: the owner of an unexpired key whose account is not
  // soft-closed, with its scope, or nullopt. This is what makes a key go inert the moment its
  // account closes, and it honours the (v1-unused) expiry.
  virtual std::optional<ActiveKey> findActiveKey(const std::string& tokenDigest, long long nowMs) = 0;

  // Advance a key's last-used stamp on its hot path, but only past the throttle so a busy client
  // does not write on every call.
  virtual void touchUsed(const std::string& tokenDigest, long long nowMs, long long throttleMs) = 0;
};

}
