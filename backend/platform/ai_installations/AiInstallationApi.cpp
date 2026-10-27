#include "platform/ai_installations/AiInstallationApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/AiBudgetJson.h"
#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Credentials.h"
namespace wm {
namespace {

std::string headerName(std::string value) {
  for (auto& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  return value;
}

std::string trimHeader(const std::string& value) {
  const auto first = value.find_first_not_of(" \t");
  if (first == std::string::npos) return {};
  return value.substr(first, value.find_last_not_of(" \t") - first + 1);
}

bool emptyObject(const drogon::HttpRequestPtr& request) {
  if (request->getBody().size() > 256) return false;
  const auto body = request->getJsonObject();
  return body && body->isObject() && body->empty();
}

drogon::HttpResponsePtr privateResponse(const drogon::HttpResponsePtr& response) {
  response->addHeader("Cache-Control", "no-store");
  return response;
}

Json::Value installationBody(const AiInstallationPrincipal& principal, const AiBudgetView& allowance) {
  Json::Value body(Json::objectValue);
  body["bound"] = principal.boundAccount().has_value();
  body["allowance"] = aiAllowanceJson(allowance);
  return body;
}

}

std::optional<std::string> aiInstallationClientAddress(const sync::HeaderOccurrences& headers,
                                                      const std::string& peer, AiInstallationProxy proxy) {
  std::optional<std::string> forwarded;
  for (const auto& [name, value] : headers) {
    const auto key = headerName(name);
    if (proxy == AiInstallationProxy::Direct &&
        (key == "cf-connecting-ip" || key == "x-forwarded-for" || key == "forwarded")) return std::nullopt;
    if (key != "cf-connecting-ip") continue;
    if (forwarded) return std::nullopt;
    forwarded = trimHeader(value);
  }
  if (proxy == AiInstallationProxy::Cloudflare && !forwarded) return std::nullopt;
  const auto& address = proxy == AiInstallationProxy::Cloudflare ? *forwarded : peer;
  return aiInstallationNetworkAddress(address);
}

AiInstallationApi::AiInstallationApi(std::shared_ptr<AiInstallations> installations, std::shared_ptr<AuthService> auth,
                                     std::shared_ptr<Entitlements> entitlements, std::shared_ptr<FailureReporter> failures,
                                     AiInstallationProxy proxy)
    : installations_(std::move(installations)), auth_(std::move(auth)), entitlements_(std::move(entitlements)),
      failures_(std::move(failures)), proxy_(proxy) {}

AiInstallationAccess AiInstallationApi::resolve(const drogon::HttpRequestPtr& request, bool requireAccount,
                                               bool requireInstallation) const {
  AiInstallationAccess result;
  const auto credential = sync::SentCredentials::fromOccurrences(request->headerOccurrences()).resolve(
      [&](const std::string& token) -> std::optional<UserId> {
        const auto account = auth_->authenticate(token);
        if (!account) return std::nullopt;
        result.account = account;
        return account->id;
      });
  if (credential.fails() || (requireAccount && !credential.servedAs())) {
    result.account.reset();
    result.refusal = "unauthenticated";
    return result;
  }
  std::optional<std::string> installationToken;
  for (const auto& [name, value] : request->headerOccurrences()) {
    if (headerName(name) != "x-windmill-installation") continue;
    if (installationToken) {
      result.refusal = "invalid_installation";
      return result;
    }
    installationToken = trimHeader(value);
  }
  if (!installations_) {
    result.refusal = "anonymous_ai_unavailable";
    return result;
  }
  if (!installationToken && !requireInstallation) return result;
  if (installationToken) result.installation = installations_->authenticate(*installationToken);
  if (!result.installation) result.refusal = "invalid_installation";
  return result;
}

AiPrincipalAccess AiInstallationApi::principal(const drogon::HttpRequestPtr& request) const {
  AiPrincipalAccess result;
  const auto credential = sync::SentCredentials::fromOccurrences(request->headerOccurrences()).resolve(
      [&](const std::string& token) -> std::optional<UserId> {
        const auto account = auth_->authenticate(token);
        if (!account) return std::nullopt;
        result.account = account;
        return account->id;
      });
  if (credential.fails()) {
    result.account.reset();
    result.refusal = "unauthenticated";
    return result;
  }
  if (result.account) return result;
  bool installationSent = false;
  for (const auto& [name, value] : request->headerOccurrences())
    installationSent = installationSent || headerName(name) == "x-windmill-installation";
  if (!installationSent) {
    result.refusal = "unauthenticated";
    return result;
  }
  const AiInstallationAccess access = resolve(request, false, true);
  if (!access.refusal.empty()) {
    result.refusal = access.refusal;
    return result;
  }
  if (access.installation->boundAccount()) {
    result.refusal = "device_bound";
    return result;
  }
  result.installation = access.installation;
  return result;
}

std::optional<std::string> AiInstallationApi::clientAddress(const drogon::HttpRequestPtr& request) const {
  return aiInstallationClientAddress(request->headerOccurrences(), request->peerAddr().toIp(), proxy_);
}

void AiInstallationApi::issue(const drogon::HttpRequestPtr& request,
                              std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  WriteObservation observation{"ai.installation.issue", "platform", "REST", "", failures_.get()};
  WriteContext context{observation};
  const auto refuse = [&](drogon::HttpStatusCode status, const std::string& code) {
    observation.finish(code);
    reply(privateResponse(error(status, "Anonymous AI access could not be started.", code.c_str())));
  };
  try {
    const auto access = resolve(request, false, false);
    if (!access.refusal.empty()) {
      refuse(access.refusal == "anonymous_ai_unavailable" ? drogon::k503ServiceUnavailable : drogon::k401Unauthorized, access.refusal);
      return;
    }
    if (!installations_->anonymousEnabled()) {
      refuse(drogon::k503ServiceUnavailable, "anonymous_ai_unavailable");
      return;
    }
    if (access.account || access.installation) {
      refuse(drogon::k409Conflict, "installation_already_present");
      return;
    }
    if (!emptyObject(request)) {
      refuse(drogon::k400BadRequest, "invalid_request");
      return;
    }
    const auto address = clientAddress(request);
    if (!address) {
      refuse(drogon::k400BadRequest, "invalid_client_address");
      return;
    }
    const auto issued = installations_->issue(*address);
    if (!issued.principal) {
      refuse(drogon::k429TooManyRequests, std::string(aiInstallationCodeName(issued.code)));
      return;
    }
    auto body = installationBody(*issued.principal, installations_->allowance(*issued.principal));
    body["credential"] = issued.credential;
    observation.skip();
    auto response = jsonResponse(body);
    response->setStatusCode(drogon::k201Created);
    reply(privateResponse(response));
  } catch (...) {
    observation.failUnknown();
    reply(privateResponse(error(drogon::k503ServiceUnavailable, "Anonymous AI access is unavailable.", "ai_accounting_unavailable")));
  }
}

void AiInstallationApi::current(const drogon::HttpRequestPtr& request,
                                std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  WriteObservation observation{"ai.installation.read", "platform", "REST", "", failures_.get()};
  WriteContext context{observation};
  try {
    const auto access = resolve(request);
    if (!access.refusal.empty()) {
      observation.skip();
      reply(privateResponse(error(access.refusal == "anonymous_ai_unavailable" ? drogon::k503ServiceUnavailable : drogon::k401Unauthorized,
                                  "Anonymous AI access is unavailable.", access.refusal.c_str())));
      return;
    }
    const auto body = installationBody(*access.installation, installations_->allowance(*access.installation));
    observation.skip();
    reply(privateResponse(jsonResponse(body)));
  } catch (...) {
    observation.failUnknown();
    reply(privateResponse(error(drogon::k503ServiceUnavailable, "Anonymous AI access is unavailable.", "ai_accounting_unavailable")));
  }
}

void AiInstallationApi::bind(const drogon::HttpRequestPtr& request,
                             std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  WriteObservation observation{"ai.installation.bind", "platform", "REST", "", failures_.get()};
  WriteContext context{observation};
  const auto refuse = [&](drogon::HttpStatusCode status, const std::string& code) {
    observation.finish(code);
    reply(privateResponse(error(status, "Anonymous AI access could not be linked.", code.c_str())));
  };
  try {
    const auto access = resolve(request, true);
    if (!access.refusal.empty()) {
      refuse(access.refusal == "anonymous_ai_unavailable" ? drogon::k503ServiceUnavailable : drogon::k401Unauthorized, access.refusal);
      return;
    }
    if (!emptyObject(request)) {
      refuse(drogon::k400BadRequest, "invalid_request");
      return;
    }
    const auto code = installations_->bind(*access.installation, access.account->id);
    if (code != AiBudgetCode::Ok && code != AiBudgetCode::Replay) {
      refuse(drogon::k409Conflict, code == AiBudgetCode::Conflict ? "installation_bound" : std::string(aiBudgetCodeName(code)));
      return;
    }
    auto body = installationBody(*access.installation, entitlements_->aiAllowanceView(access.account->id, access.account->email.value));
    body["bound"] = true;
    observation.finish(code == AiBudgetCode::Replay ? "replay" : "ok");
    reply(privateResponse(jsonResponse(body)));
  } catch (...) {
    observation.failUnknown();
    reply(privateResponse(error(drogon::k503ServiceUnavailable, "Anonymous AI access could not be linked.", "ai_accounting_unavailable")));
  }
}

}
