#include "platform/adapters/http/Caller.h"

#include <cstddef>
#include <string>

namespace wm {

std::string sessionSecretOf(const drogon::HttpRequestPtr& req) {
  std::string secret = req->getCookie("wm_session");
  if (!secret.empty()) return secret;
  const std::string authorization = req->getHeader("authorization");
  if (authorization.rfind("Bearer ", 0) == 0) return authorization.substr(7);
  return "";
}

std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  std::optional<User> user = auth.authenticate(sessionSecretOf(req));
  // The one place that decides who is behind a request, so the one place that records it — the
  // access log runs after the handler and has no way of its own to know.
  if (user) req->attributes()->insert(kCallerAttribute, user->id.str());
  return user;
}

std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  const std::optional<User> user = callerUserOf(req, auth);
  if (!user) return std::nullopt;
  return user->id;
}

sync::SentCredentials sentCredentialsOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  return sync::SentCredentials::fromOccurrences(req->headerOccurrences(), [&auth](const std::string& token) { return auth.digestOf(token); });
}

SentCaller SentCaller::of(const sync::SentCredentials& sent, AuthService& auth, const SessionContext& ctx) {
  std::optional<User> user;
  const sync::Credential credential = sent.resolve([&auth, &ctx, &user](const std::string& digest) -> std::optional<UserId> {
    user = auth.revalidate(digest, ctx);
    return user ? std::optional(user->id) : std::nullopt;
  });
  if (credential.fails()) return SentCaller{credential, std::nullopt};
  return SentCaller{credential, user};
}

SentCaller SentCaller::of(const drogon::HttpRequestPtr& req, AuthService& auth, const SessionContext& ctx) {
  return of(sentCredentialsOf(req, auth), auth, ctx);
}

bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i)
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  return diff == 0;
}

}
