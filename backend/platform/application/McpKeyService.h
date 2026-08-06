#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/ToolScope.h"
#include "platform/ports/Clock.h"
#include "platform/ports/McpKeyRepository.h"
#include "platform/ports/TokenGenerator.h"

#include <optional>
#include <string>
#include <vector>

namespace wm {

// A freshly minted MCP API key: its public id, display name, the one-time secret to hand the
// user, and when it was created. The secret leaves here exactly once — only its digest is
// stored — so this is the only moment the raw token is ever in hand.
struct MintedKey {
  std::string id;
  std::string name;
  std::string token;
  long long createdMs = 0;
};

// One row of the settings MCP-keys list, dressed for the API: the digest and the secret are
// gone, leaving only what the list shows. lastUsedMs is null until the key first acts.
struct McpKeyView {
  std::string id;
  std::string name;
  long long createdMs = 0;
  std::optional<long long> lastUsedMs;
};

// Personal MCP API keys: long-lived per-user bearer tokens that authenticate MCP requests as a
// static-token fallback for clients that can't do OAuth. Each method is a fail-fast pipeline —
// mint a secret and store only its digest, resolve a presented secret back to its owner. The
// token is a credential end-to-end: shown once at mint, never again.
class McpKeyService {
public:
  McpKeyService(McpKeyRepository& repo, TokenGenerator& tokens, Clock& clock);

  // Mint a key for the user. A blank name is stored as "MCP key", an over-long one capped to 60
  // characters. The returned token is the only copy the user will ever see.
  MintedKey mint(const UserId& user, const std::string& name);

  // The settings list, newest first, never the token.
  std::vector<McpKeyView> list(const UserId& user);

  // Revoke one of the user's keys by its public id; false when no such key is owned by the user.
  bool revoke(const UserId& user, const std::string& id);

  // Resource-server validation: the account a presented key secret authenticates as and the grant
  // that key carries, or nullopt. A resolved key advances its last-used stamp (throttled), so the
  // list shows honest activity; a key whose account has soft-closed resolves to nullopt (the
  // repository's deleted_at guard).
  std::optional<ToolCaller> resolveKey(const std::string& secret);

private:
  static constexpr long long kTouchThrottleMs = 60'000;  // last-used writes at most once a minute

  McpKeyRepository& repo_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
