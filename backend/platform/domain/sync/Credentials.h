#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// §9.1 Credentials: what a request sends, read from its header field lines as received, the principal it is served as,
// and the session it is served through. A token is held as its digest from the moment it is read: no raw token outlives
// the parse, so none reaches a session's row as a key.

namespace wm::sync {

// The session cookie.
inline constexpr char kSessionCookie[] = "wm_session";

// A request's header field lines as received: every occurrence in order, each name as sent and the bytes after its
// colon, whitespace included (Drogon's HttpRequest::headerOccurrences, third_party/drogon).
using HeaderOccurrences = std::vector<std::pair<std::string, std::string>>;

// What a request's credentials resolve to: nothing sent, so the request is anonymous; or sent, resolving to an account
// through a session, or to none.
class Credential {
public:
  // A request that sends none: it is anonymous.
  static Credential none();
  // A request that sends credentials, which resolve to `account` through the session whose token's digest is `session`,
  // or to none.
  static Credential sent(std::optional<UserId> account, std::optional<std::string> session = std::nullopt);

  // Sent credentials that resolve to no account, or to an id outside §9.1's form. Every endpoint answers them 401
  // unauthenticated, and none serves them as anonymous.
  bool fails() const;
  // §9.1 Principal: the account a request that does not fail is served as; nullopt when it sends no credential.
  const std::optional<UserId>& servedAs() const { return account_; }
  // The digest of the token of the session the request is served through: the cookie's when the request sends one, else
  // its Authorization's. nullopt when its credentials resolve to none.
  const std::optional<std::string>& session() const { return session_; }

private:
  Credential(bool sent, std::optional<UserId> account, std::optional<std::string> session);

  bool sent_ = false;
  std::optional<UserId> account_;
  std::optional<std::string> session_;
};

// One credential a request sends: an Authorization line, or a Cookie piece named the session cookie, whatever its
// shape. Its token is the token of `Authorization: Bearer <token>` (the scheme in any case) or of `wm_session=<token>`,
// verbatim: no quote is stripped and nothing is unescaped, and `digest` is that token's digest. Any other shape carries
// none and resolves to no account: another scheme, a bare `Bearer`, a bare `wm_session` with no `=`, or an empty value.
struct SentCredential {
  enum class Kind { authorization, cookie };

  Kind kind;
  std::optional<std::string> digest;

  bool operator==(const SentCredential&) const = default;
};

// What the server keeps of a session's token: its digest.
using DigestOf = std::function<std::string(const std::string& token)>;
// Resolves one token's digest to the account its live session holds, or to none.
using ResolveDigest = std::function<std::optional<UserId>(const std::string& digest)>;

// Every credential a request sends, in the order its header lines send them, each token held as its digest.
class SentCredentials {
public:
  // Each Authorization line is one, and each piece of a Cookie line, split on `;`, whose name is the session cookie.
  // Header names compare in ASCII case only; the session cookie's name compares exactly. Space and tab, and nothing
  // else, are trimmed around a field value and around a Cookie piece's name and value (RFC 9110 OWS, RFC 6265). Each
  // token is held as `digestOf` makes it.
  static SentCredentials fromOccurrences(const HeaderOccurrences& occurrences, const DigestOf& digestOf);

  // None sent.
  SentCredentials() = default;
  explicit SentCredentials(std::vector<SentCredential> each) : each_(std::move(each)) {}

  // The credential they make: none when nothing is sent. Otherwise they resolve only when at most one of each kind is
  // sent, each carries a digest that `resolve` resolves, and a cookie and a header sent together name one account. Two
  // of one kind are refused before any digest is resolved. A credential that resolves is served through the cookie's
  // session when one is sent, else the Authorization's.
  Credential resolve(const ResolveDigest& resolve) const;

  const std::vector<SentCredential>& each() const { return each_; }

  bool operator==(const SentCredentials&) const = default;

private:
  std::vector<SentCredential> each_;
};

}
