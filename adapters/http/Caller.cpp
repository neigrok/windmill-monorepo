#include "adapters/http/Caller.h"

#include <string>

namespace wm {

std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req, AuthService& auth) {
  std::string secret = req->getCookie("wm_session");
  if (secret.empty()) {
    std::string authorization = req->getHeader("authorization");
    if (authorization.rfind("Bearer ", 0) == 0) secret = authorization.substr(7);
  }
  std::optional<User> user = auth.authenticate(secret);
  if (!user) return std::nullopt;
  return user->id;
}

}
