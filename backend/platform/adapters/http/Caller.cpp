#include "platform/adapters/http/Caller.h"

#include <cstddef>
#include <string>

namespace wm {

std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth.authenticate(secret);
  // The access log runs after the handler and has no way of its own to know who was behind the
  // request. This is the one place that decides, so it is the one place that records it — every
  // surface gets an attributed log line without a single handler being asked to cooperate.
  if (user) req->attributes()->insert(kCallerAttribute, user->id.str());
  return user;
}

std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  const std::optional<User> user = callerUserOf(req, auth);
  if (!user) return std::nullopt;
  return user->id;
}

bool secretEqual(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i)
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  return diff == 0;
}

}
