#include "platform/adapters/http/Caller.h"

#include "platform/adapters/http/JsonReply.h"

#include <cstddef>
#include <string>

namespace wm {

sync::SentCredentials sentCredentialsOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  return sync::SentCredentials::fromOccurrences(req->headerOccurrences(), [&auth](const std::string& token) { return auth.digestOf(token); });
}

SentCaller SentCaller::of(const sync::SentCredentials& sent, AuthService& auth, const SessionContext& ctx) {
  std::optional<User> held;
  const sync::Credential credential = sent.resolve([&auth, &ctx, &held](const std::string& digest) -> std::optional<UserId> {
    held = auth.revalidate(digest, ctx);
    return held ? std::optional(held->id) : std::nullopt;
  });
  if (!credential.fails()) return SentCaller{credential, held, false};
  const bool lapsed = sent.each().size() == 1 && sent.each().front().digest && !held;
  return SentCaller{credential, std::nullopt, lapsed};
}

SentCaller SentCaller::of(const drogon::HttpRequestPtr& req, AuthService& auth, const SessionContext& ctx) {
  SentCaller caller = of(sentCredentialsOf(req, auth), auth, ctx);
  // The access log runs after the handler and has no way of its own to know whom the request was served as.
  if (caller.user) req->attributes()->insert(kCallerAttribute, caller.user->id.str());
  else if (caller.credential.fails()) req->attributes()->insert(kCallerAttribute, std::string(caller.lapsed ? "lapsed" : "refused"));
  return caller;
}

std::optional<UserId> SentCaller::account() const {
  if (!user) return std::nullopt;
  return user->id;
}

bool SentCaller::refused() const {
  return credential.fails() && !lapsed;
}

drogon::HttpResponsePtr refusedCredentials() {
  return error(drogon::k401Unauthorized, "Sign in again: this request's credentials do not name one signed-in account.", "unauthenticated");
}

bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i)
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  return diff == 0;
}

}
