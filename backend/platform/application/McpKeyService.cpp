#include "platform/application/McpKeyService.h"

#include <cstddef>

namespace wm {

namespace {
constexpr std::size_t kNameCap = 60;

// The name a key is stored under: trimmed, defaulted to "MCP key" when blank, capped to 60.
std::string storedName(const std::string& raw) {
  const std::size_t begin = raw.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return "MCP key";
  const std::size_t end = raw.find_last_not_of(" \t\r\n");
  std::string name = raw.substr(begin, end - begin + 1);
  if (name.size() > kNameCap) name.resize(kNameCap);
  return name;
}
}

McpKeyService::McpKeyService(McpKeyRepository& repo, TokenGenerator& tokens, Clock& clock)
    : repo_(repo), tokens_(tokens), clock_(clock) {}

MintedKey McpKeyService::mint(const UserId& user, const std::string& name) {
  const long long now = static_cast<long long>(clock_.nowMs());
  const std::string keyName = storedName(name);
  const MintedToken minted = tokens_.mint();
  const std::string id = repo_.insert(minted.digest, user, keyName, now);
  return MintedKey{id, keyName, minted.secret, now};
}

std::vector<McpKeyView> McpKeyService::list(const UserId& user) {
  std::vector<McpKeyView> views;
  for (const McpKeyRow& row : repo_.list(user))
    views.push_back(McpKeyView{row.id, row.name, row.createdMs, row.lastUsedMs});
  return views;
}

bool McpKeyService::revoke(const UserId& user, const std::string& id) { return repo_.revoke(user, id); }

std::optional<ToolCaller> McpKeyService::resolveKey(const std::string& secret) {
  const std::string digest = tokens_.digestOf(secret);
  const long long now = static_cast<long long>(clock_.nowMs());
  const std::optional<ActiveKey> key = repo_.findActiveKey(digest, now);
  if (!key) return std::nullopt;
  repo_.touchUsed(digest, now, kTouchThrottleMs);
  return ToolCaller{key->user, parseToolScope(key->scope), ToolConnection{key->id, key->name}};
}

}
