#pragma once

#include "platform/ai_installations/AiInstallations.h"
#include "platform/application/AuthService.h"
#include "platform/domain/sync/Credentials.h"
#include "platform/application/Entitlements.h"
#include "platform/ports/FailureReporter.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

namespace wm {

enum class AiInstallationProxy { Direct, Cloudflare };
std::optional<std::string> aiInstallationClientAddress(const sync::HeaderOccurrences& headers,
                                                     const std::string& peer, AiInstallationProxy proxy);

struct AiInstallationAccess {
  std::optional<AiInstallationPrincipal> installation;
  std::optional<User> account;
  std::string refusal;
};

// Who a hosted-AI route serves: the account behind a session or bearer credential, else the
// installation behind `X-Windmill-Installation`. An account outranks an installation sent beside it.
// A refusal is `unauthenticated` (an invalid account credential, or neither credential),
// `invalid_installation`, `anonymous_ai_unavailable`, or `device_bound` (an installation already
// bound to an account, which must sign in instead).
struct AiPrincipalAccess {
  std::optional<User> account;
  std::optional<AiInstallationPrincipal> installation;
  std::string refusal;
};

class AiInstallationApi {
public:
  AiInstallationApi(std::shared_ptr<AiInstallations> installations, std::shared_ptr<AuthService> auth,
                    std::shared_ptr<Entitlements> entitlements, std::shared_ptr<FailureReporter> failures,
                    AiInstallationProxy proxy);
  AiInstallationAccess resolve(const drogon::HttpRequestPtr& request, bool requireAccount = false,
                               bool requireInstallation = true) const;
  // The seat of a route an account or an installation may open — the Coach turn routes.
  AiPrincipalAccess principal(const drogon::HttpRequestPtr& request) const;
  std::optional<std::string> clientAddress(const drogon::HttpRequestPtr& request) const;
  void issue(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);
  void current(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);
  void bind(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply);

private:
  std::shared_ptr<AiInstallations> installations_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  std::shared_ptr<FailureReporter> failures_;
  AiInstallationProxy proxy_;
};

}
