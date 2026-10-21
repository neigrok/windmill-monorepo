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

class AiInstallationApi {
public:
  AiInstallationApi(std::shared_ptr<AiInstallations> installations, std::shared_ptr<AuthService> auth,
                    std::shared_ptr<Entitlements> entitlements, std::shared_ptr<FailureReporter> failures,
                    AiInstallationProxy proxy);
  AiInstallationAccess resolve(const drogon::HttpRequestPtr& request, bool requireAccount = false,
                               bool requireInstallation = true) const;
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
