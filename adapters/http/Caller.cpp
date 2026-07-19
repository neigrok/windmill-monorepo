#include "adapters/http/Caller.h"

#include <string>

namespace wm {

std::optional<User> callerUserOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  return auth.authenticate(secret);
}

std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  const std::optional<User> user = callerUserOf(req, auth);
  if (!user) return std::nullopt;
  return user->id;
}

}
