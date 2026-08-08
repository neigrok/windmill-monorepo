#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/AiUsageRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// THE OWNER'S READ OF THE AI LEDGER — two GETs, and the only doors in the product that answer to a
// list of people rather than to an account's own data.
//
// The allowlist is `WINDMILL_OWNER_EMAILS`, read ONCE at construction and matched against the
// SESSION account's email — never a header, never a body, never a claim the client makes about
// itself. Absent or empty means CLOSED, the same fail-shut the four existing admin doors take: an
// unset variable in a fresh deployment must open nothing.
//
// Every refusal is **404, byte-identical** — signed out, signed in and not an owner, and no such
// route are one answer. Not 403, which would confirm the room exists to whoever knocked; and not
// 401, which would pop the sign-in door on a surface no signing in can reach. This repo settled the
// shape once already in the tree-visibility wave: a private thing denies exactly as an absent one
// does.
//
// Nothing about ownership is broadcast anywhere else — `/v1/auth/me` gains no `owner` field. A flag
// sent to every account forever, to serve two people, would invent the product's first role and
// invite a client-side gate that is not one.
class UsageAdminApi {
public:
  UsageAdminApi(std::shared_ptr<AiUsageRepository> usage, std::shared_ptr<AuthService> auth,
                const std::string& ownerEmails);

  void summary(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // GET /v1/admin/usage/summary
  void users(const drogon::HttpRequestPtr& req, HttpCallback&& callback);    // GET /v1/admin/usage/users

private:
  bool isOwner(const drogon::HttpRequestPtr& req) const;

  std::shared_ptr<AiUsageRepository> usage_;
  std::shared_ptr<AuthService> auth_;
  std::vector<std::string> owners_;  // folded and trimmed at construction, so the compare is plain
};

}
