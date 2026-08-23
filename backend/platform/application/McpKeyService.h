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

// `token` leaves here exactly once; only its digest is stored.
struct MintedKey {
  std::string id;
  std::string name;
  std::string token;
  long long createdMs = 0;
};

// The API shape: no digest, no secret. lastUsedMs is null until the key first acts.
struct McpKeyView {
  std::string id;
  std::string name;
  long long createdMs = 0;
  std::optional<long long> lastUsedMs;
};

// Personal MCP API keys: long-lived per-user bearer tokens, the static-token fallback for clients
// that cannot do OAuth. Only a digest is stored; the token is shown once at mint and never again.
class McpKeyService {
public:
  McpKeyService(McpKeyRepository& repo, TokenGenerator& tokens, Clock& clock);

  // A blank name is stored as "MCP key", an over-long one capped to 60 characters. The returned
  // token is the only copy the user will ever see.
  MintedKey mint(const UserId& user, const std::string& name);

  // Newest first, never the token.
  std::vector<McpKeyView> list(const UserId& user);

  // False when no such key is owned by the user.
  bool revoke(const UserId& user, const std::string& id);

  // The account a presented key authenticates as and the grant it carries, or nullopt. A resolved
  // key advances its last-used stamp (throttled); a soft-closed account resolves to nullopt.
  std::optional<ToolCaller> resolveKey(const std::string& secret);

private:
  static constexpr long long kTouchThrottleMs = 60'000;  // last-used writes at most once a minute

  McpKeyRepository& repo_;
  TokenGenerator& tokens_;
  Clock& clock_;
};

}
