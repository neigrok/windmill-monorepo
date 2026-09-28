#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// §9.1 Credentials: what a request sends, read from its header fields as received, and the principal it is served as.

namespace wm::sync {

// The session cookie.
inline constexpr char kSessionCookie[] = "wm_session";

// A request's header fields as received: every occurrence in order, each name as sent and its value without the
// whitespace around it. A framework's header map keeps one of two, so the fields are read before one is built.
using HeaderFields = std::vector<std::pair<std::string, std::string>>;

// One credential a request sends: an Authorization header, or a Cookie piece named the session cookie, whatever its
// shape. A Cookie header splits on `;` into pieces, each trimmed of whitespace as the reference trims it (sentCredentialsOf
// names it). `token` is the token of `Authorization: Bearer <token>` (the scheme in any case) or of `wm_session=<token>`,
// verbatim: no quote is stripped and nothing is unescaped. Any other shape carries none and resolves to no account:
// another scheme, a bare `Bearer`, a bare `wm_session` with no `=`, or an empty value.
struct SentCredential {
  enum class Kind { authorization, cookie };

  Kind kind;
  std::optional<std::string> token;

  bool operator==(const SentCredential&) const = default;
};

// Every credential `headers` send, in the order they send them.
std::vector<SentCredential> sentCredentialsOf(const HeaderFields& headers);

// What a request's credentials resolve to: nothing sent, so the request is anonymous; or sent, resolving to an account
// or to none.
class Credential {
public:
  // A request that sends none: it is anonymous.
  static Credential none();
  // A request that sends credentials, which resolve to `account`, or to none.
  static Credential sent(std::optional<UserId> account);

  // Sent credentials that resolve to no account, or to an id outside §9.1's form. Every endpoint answers them 401
  // unauthenticated, and none serves them as anonymous.
  bool fails() const;
  // §9.1 Principal: the account a request that does not fail is served as; nullopt when it sends no credential.
  const std::optional<UserId>& servedAs() const { return account_; }

private:
  Credential(bool sent, std::optional<UserId> account);

  bool sent_ = false;
  std::optional<UserId> account_;
};

// Resolves one token to the account its live session holds, or to none.
using ResolveToken = std::function<std::optional<UserId>(const std::string& token)>;

// The credential `sent` make: none when the list is empty. Otherwise they resolve only when at most one of each kind is
// sent, each carries a token that `resolve` resolves, and a cookie and a header sent together name one account. Two of
// one kind are refused before any token is resolved.
Credential credentialOf(const std::vector<SentCredential>& sent, const ResolveToken& resolve);

}
