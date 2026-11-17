#include "platform/ai_passes/AiPassApi.h"
#include "platform/adapters/http/MutationPolicy.h"
#include <algorithm>

namespace wm {
namespace {
const WriteMetadataField passMetadata[] = {
    {"client", {"web", "ios", "android", "server"}},
    {"use", {}},
    {"version", {}, 10, true},
    {"principal", {"account", "installation"}},
    {"plan", {"none", "one"}}};
}

AiPassApi::AiPassApi(std::shared_ptr<AiPasses> passes, std::shared_ptr<AuthService> auth,
                     std::shared_ptr<AiInstallations> installations, std::shared_ptr<Entitlements> entitlements,
                     std::shared_ptr<RateLimiter> limiter, Clock& clock, std::set<std::string> origins,
                     AiInstallationProxy proxy)
    : passes_(std::move(passes)), auth_(std::move(auth)), installations_(std::move(installations)),
      entitlements_(std::move(entitlements)), limiter_(std::move(limiter)), clock_(clock),
      origins_(std::move(origins)), proxy_(proxy) {}

void AiPassApi::sign(const drogon::HttpRequestPtr& request, std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  const auto observation = beginWriteRequest(request);
  const auto refuse = [&](drogon::HttpStatusCode status, const char* code) {
    const auto response = error(status, "AI access could not be started.", code);
    reply(response);
  };
  try {
    const auto sent = sync::SentCredentials::fromOccurrences(request->headerOccurrences());
    std::optional<std::string> installationToken;
    bool cookie = false;
    for (const auto& credential : sent.each()) cookie = cookie || credential.kind == sync::SentCredential::Kind::cookie;
    for (auto [name, value] : request->headerOccurrences()) {
      std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 'a' - 'A' : c; });
      const auto first = value.find_first_not_of(" \t");
      value = first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \t") - first + 1);
      if (name == "x-windmill-installation") {
        if (installationToken) { refuse(drogon::k401Unauthorized, "invalid_installation"); return; }
        installationToken = value;
      }
    }
    const auto mutation = MutationPolicy{MutationHeaders::Occurrences, cookie, true}.check(request, origins_);
    if (mutation == MutationRefusal::UntrustedOrigin) { refuse(drogon::k403Forbidden, "untrusted-origin"); return; }
    if (mutation == MutationRefusal::UnsupportedMediaType) { refuse(drogon::k415UnsupportedMediaType, "unsupported-media-type"); return; }
    const auto input = AiPassRequest::parse(request->getBody());
    if (!input) { refuse(drogon::k400BadRequest, "invalid_request"); return; }
    const auto versionRefusal = passes_->refusal(*input);
    if (observation && (versionRefusal.empty() || versionRefusal == "client-update-required"))
      observation->metadata(passMetadata, {{"client", input->client}, {"use", input->use}, {"version", std::to_string(input->version)}});
    if (!versionRefusal.empty()) {
      refuse(versionRefusal == "client-update-required" ? drogon::k426UpgradeRequired : drogon::k400BadRequest, versionRefusal.c_str()); return;
    }
    std::optional<User> account;
    const auto credentials = sent.resolve([&](const std::string& token) -> std::optional<UserId> {
      const auto user = auth_->authenticate(token);
      if (!user) return std::nullopt;
      account = user;
      return user->id;
    });
    if (credentials.fails() || (!account && !installationToken)) { refuse(drogon::k401Unauthorized, "unauthenticated"); return; }
    std::optional<AiInstallationPrincipal> installation;
    if (installationToken) {
      if (!installations_) { refuse(drogon::k503ServiceUnavailable, "anonymous_ai_unavailable"); return; }
      installation = installations_->authenticate(*installationToken);
      if (!installation) { refuse(drogon::k401Unauthorized, "invalid_installation"); return; }
    }
    AiBudgetPrincipal principal;
    std::optional<std::string> boundInstallation;
    if (account) {
      principal = entitlements_->aiPrincipalFor(account->id, account->email.value);
      if (installation && installation->boundAccount() == account->id.str()) boundInstallation = installation->id();
    } else {
      if (installation->boundAccount()) { refuse(drogon::k409Conflict, "device_bound"); return; }
      if (!installations_->anonymousEnabled()) { refuse(drogon::k503ServiceUnavailable, "anonymous_ai_unavailable"); return; }
      principal = {{AiBudgetSubjectKind::Device, installation->id()}, AiBudgetTier::Anonymous};
    }
    const std::string kind = account ? "account" : "installation";
    if (observation) observation->metadata(passMetadata, {{"principal", kind}, {"plan", account && principal.tier == AiBudgetTier::WindmillOne ? "one" : "none"}});
    if (!limiter_->allow(kind + ":" + principal.subject.id)) { refuse(drogon::k429TooManyRequests, "rate_limited"); return; }
    if (!account) {
      const auto address = aiInstallationClientAddress(request->headerOccurrences(), request->peerAddr().toIp(), proxy_);
      if (!address) { refuse(drogon::k400BadRequest, "invalid_request"); return; }
      const auto admission = installations_->admitPass(*installation, *address);
      if (admission == AiInstallationCode::DeviceBound) { refuse(drogon::k409Conflict, "device_bound"); return; }
      if (admission == AiInstallationCode::Unavailable) { refuse(drogon::k503ServiceUnavailable, "anonymous_ai_unavailable"); return; }
      if (admission != AiInstallationCode::Ok) { refuse(drogon::k429TooManyRequests, "rate_limited"); return; }
    }
    Json::Value responseBody(Json::objectValue);
    responseBody["pass"] = passes_->sign(passes_->claims(principal, boundInstallation, input->client, clock_.nowMs()));
    responseBody["expiresIn"] = Json::Int64(kAiPassLifetimeMs);
    const auto response = jsonResponse(responseBody);
    reply(response);
  } catch (...) {
    reportCurrentUnknownWriteFailure();
    refuse(drogon::k503ServiceUnavailable, "unavailable");
  }
}

}
