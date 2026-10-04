#include "platform/adapters/http/SyncApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Jcs.h"

#include <charconv>
#include <utility>

namespace wm::sync {

SyncApi::SyncApi(SyncDeps deps) : deps_(std::move(deps)) {}

void SyncApi::onWorker(const drogon::HttpRequestPtr& req, Reply&& reply, std::function<SyncReply()> work) {
  auto answer = std::make_shared<Reply>(std::move(reply));
  const auto observation = beginWriteRequest(req);
  const std::string requestId = writeRequestId();
  const bool posted = deps_.workers->post([this, req, answer, observation, requestId, work = std::move(work)] {
    std::unique_ptr<WriteContext> context;
    if (observation) context = std::make_unique<WriteContext>(*observation);
    else context = std::make_unique<WriteContext>(requestId);
    try {
      (*answer)(responseOf(work()));
    } catch (const std::exception& error) {
      writeHttpFailure(req, error);
      (*answer)(responseOf(SyncReply::unavailable(SyncReply::envelope(deps_.clock->nowMs(), deps_.epoch))));
    } catch (...) {
      writeHttpFailureUnknown(req);
      throw;
    }
  });
  if (!posted) (*answer)(responseOf(SyncReply::unavailable(SyncReply::envelope(deps_.clock->nowMs(), deps_.epoch))));
}

void SyncApi::hello(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(req, std::move(reply), [this, req] {
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->hello(credentialOf(req));
  });
}

void SyncApi::push(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(req, std::move(reply), [this, req] {
    TimeBudget budget(deps_.limits.pushWorkMs);
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->push(credentialOf(req), req->body(), budget);
  });
}

void SyncApi::pull(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(req, std::move(reply), [this, req] {
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->pull(credentialOf(req), req->body());
  });
}

std::optional<SyncReply> SyncApi::versionRefusal(const drogon::HttpRequestPtr& req) const {
  // Drogon presents a repeated header as its first value.
  return schemaRefusal(req->getHeader("sync-schema"), deps_.minSchema, deps_.clock->nowMs(), deps_.epoch);
}

Credential SyncApi::credentialOf(const drogon::HttpRequestPtr& req) const {
  const Credential credential = SentCredentials::fromOccurrences(req->headerOccurrences()).resolve([this](const std::string& token) -> std::optional<UserId> {
    const std::optional<User> user = deps_.auth->authenticate(token);
    return user ? std::optional(user->id) : std::nullopt;
  });
  if (!credential.fails() && credential.servedAs()) req->attributes()->insert(kCallerAttribute, credential.servedAs()->str());
  return credential;
}

std::optional<SyncReply> schemaRefusal(std::string_view version, std::int64_t minSchema, Ms serverTime, const std::string& epoch) {
  const Json::Value envelope = SyncReply::envelope(serverTime, epoch);
  std::int64_t schema = 0;
  const auto [end, error] = std::from_chars(version.data(), version.data() + version.size(), schema);
  const bool decimal = !version.empty() && end == version.data() + version.size();
  if (!decimal || (error != std::errc{} && error != std::errc::result_out_of_range)) return SyncReply::refused(400, envelope, "malformed");
  // A decimal integer past int64 is past every version, and below minSchema only when it is negative.
  const bool below = error == std::errc::result_out_of_range ? version.front() == '-' : schema < minSchema;
  if (below) return SyncReply::refused(426, envelope, "upgrade-required");
  return std::nullopt;
}

drogon::HttpResponsePtr responseOf(const SyncReply& reply) {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(static_cast<drogon::HttpStatusCode>(reply.status));
  response->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  response->setBody(jcs(reply.body));
  return response;
}

void registerSyncRoutes(drogon::HttpAppFramework& app, const std::shared_ptr<SyncApi>& api) {
  WriteRoutes routes(app, "platform", "sync");
  routes.registerWriteHandler(
      "sync.hello", "/v1/sync/hello", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->hello(req, std::move(reply)); }, {drogon::Get});
  routes.registerWriteHandler(
      "sync.push", "/v1/sync/push", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->push(req, std::move(reply)); }, {drogon::Post});
  routes.registerWriteHandler(
      "sync.pull", "/v1/sync/pull", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->pull(req, std::move(reply)); }, {drogon::Post});
}

}
