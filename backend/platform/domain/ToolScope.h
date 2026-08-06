#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// The second authorization axis, and the one Access.h deliberately knows nothing about. That file
// answers OWNERSHIP — a resource is its owner's to change — and a read-only credential authenticates
// to the very same account a full one does, so it passes every ownership gate identically. This one
// answers how far the CREDENTIAL reaches, which is why it is enforced above the domain, at the tool
// boundary: it is a fact about the grant, never about the resource.
//
// Three levels, and none of them implies another — naming `write` hands you neither `read` nor, above
// all, `delete`. That last separation is the whole gate: a connection that was not granted
// `gym:delete` never even sees a delete tool in tools/list, so the destructive reach of a token is a
// thing the human approved rather than a thing that rode along.
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

// What one credential was granted: a set of (product, level) pairs. The product is an opaque string
// here on purpose — platform must not name products, and a grant naming a product this server does
// not serve simply matches no tool, which is the fail-closed answer anyway.
class ToolScope {
public:
  using Grant = std::pair<std::string, Access>;

  ToolScope() = default;  // grants nothing — the fail-closed default a forgotten field lands on
  explicit ToolScope(std::set<Grant> grants) : grants_(std::move(grants)) {}

  // The account-wide grant: every product, every level, including the ones added after this token
  // was minted. Written explicitly at the doors that carry it so the widest reach is the most
  // visible line in the file, never a default that reads as an omission.
  static ToolScope everything() {
    ToolScope scope;
    scope.everything_ = true;
    return scope;
  }

  bool allows(const std::string& product, Access access) const {
    if (everything_) return true;
    return grants_.count(Grant{product, access}) > 0;
  }

  // The OAuth wire spelling, canonical: the account-wide grant renders as the empty string, which is
  // exactly what parseToolScope reads it back from.
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

// Parse the OAuth `scope` parameter: space-delimited `<product>:<level>` tokens. A token that is not
// spelled that way, or whose level is not one of the three, confers NOTHING — a typo at rest can only
// ever narrow a grant, never widen one, the same fail-closed stance parseVisibility takes.
//
// The one exception is the empty string, and it is deliberate rather than an oversight: every code and
// token already at rest carries `scope ''` — the columns default to it and no client has ever sent a
// scope — so empty has to keep meaning the account-wide grant this server issued before it had a
// vocabulary. Narrowing it here would not be a fix; it would disconnect every tool anyone has
// connected, on deploy, silently.
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

// Every scope token a server serving these products honours, in the order a consent screen reads
// them. Derived from what is actually connected rather than written down twice, so the
// `scopes_supported` an authorization server advertises cannot promise a product it does not serve.
inline std::vector<std::string> supportedScopes(const std::vector<std::string>& products) {
  std::vector<std::string> tokens;
  for (const std::string& product : products)
    for (Access access : {Access::read, Access::write, Access::del})
      tokens.push_back(product + ":" + toString(access));
  return tokens;
}

// Who is calling and how far their credential reaches, resolved once at the transport's
// authentication point and carried unchanged from there to the tool. The two travel together because
// every credential answers both questions at once and neither is useful alone.
struct ToolCaller {
  UserId user;
  ToolScope scope;
};

}
