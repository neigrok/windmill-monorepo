#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// How far a CREDENTIAL reaches, enforced at the tool boundary; Access.h answers ownership instead.
// No level implies another: naming `write` grants neither `read` nor `delete`.
enum class Access { read, write, del };  // `del` because `delete` is a keyword; the wire spells it out

inline std::string toString(Access access) {
  if (access == Access::write) return "write";
  if (access == Access::del) return "delete";
  return "read";
}

inline std::optional<Access> parseAccess(const std::string& level) {
  if (level == "read") return Access::read;
  if (level == "write") return Access::write;
  if (level == "delete") return Access::del;
  return std::nullopt;
}

// A set of (product, level) pairs. The product is an opaque string: a grant naming a product this
// server does not serve matches no tool.
class ToolScope {
public:
  using Grant = std::pair<std::string, Access>;

  ToolScope() = default;  // grants nothing
  explicit ToolScope(std::set<Grant> grants) : grants_(std::move(grants)) {}

  // Every product, every level, including ones added after the token was minted.
  static ToolScope everything() {
    ToolScope scope;
    scope.everything_ = true;
    return scope;
  }

  bool allows(const std::string& product, Access access) const {
    if (everything_) return true;
    return grants_.count(Grant{product, access}) > 0;
  }

  // OAuth wire spelling; the account-wide grant renders as the empty string.
  std::string toString() const {
    if (everything_) return "";
    std::string out;
    for (const Grant& grant : grants_) {
      if (!out.empty()) out += ' ';
      out += grant.first + ":" + wm::toString(grant.second);
    }
    return out;
  }

  bool operator==(const ToolScope&) const = default;

private:
  bool everything_ = false;
  std::set<Grant> grants_;
};

// Space-delimited `<product>:<level>` tokens. A malformed token or unknown level confers nothing,
// so a typo at rest can only narrow a grant. The empty string means the account-wide grant: that is
// what every code and token at rest carries.
inline ToolScope parseToolScope(const std::string& spaceDelimited) {
  std::vector<std::string> tokens;
  std::istringstream stream(spaceDelimited);
  for (std::string token; stream >> token;) tokens.push_back(token);
  if (tokens.empty()) return ToolScope::everything();

  std::set<ToolScope::Grant> grants;
  for (const std::string& token : tokens) {
    const std::size_t colon = token.rfind(':');
    if (colon == std::string::npos || colon == 0 || colon + 1 == token.size()) continue;
    if (std::optional<Access> level = parseAccess(token.substr(colon + 1)))
      grants.insert(ToolScope::Grant{token.substr(0, colon), *level});
  }
  return ToolScope(std::move(grants));
}

// Derived from the products actually connected, so `scopes_supported` cannot advertise one that
// is not served.
inline std::vector<std::string> supportedScopes(const std::vector<std::string>& products) {
  std::vector<std::string> tokens;
  for (const std::string& product : products)
    for (Access access : {Access::read, Access::write, Access::del})
      tokens.push_back(product + ":" + toString(access));
  return tokens;
}

// The credential's own identity, not the account it acts for: over OAuth the client id and its
// registered name, over an MCP key the key's public id and name. Both empty means no connection
// stands behind the call at all, never an identity we failed to look up.
struct ToolConnection {
  std::string id;
  std::string name;

  bool operator==(const ToolConnection&) const = default;
};

// Resolved once at the transport's authentication point and carried unchanged to the tool.
struct ToolCaller {
  UserId user;
  ToolScope scope;
  ToolConnection connection;
};

}
