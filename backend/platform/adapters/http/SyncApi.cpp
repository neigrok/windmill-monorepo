#include "platform/adapters/http/SyncApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/domain/sync/Jcs.h"

#include <trantor/utils/Logger.h>

#include <charconv>
#include <typeinfo>
#include <utility>

namespace wm::sync {

SyncApi::SyncApi(SyncDeps deps) : deps_(std::move(deps)) {}

void SyncApi::onWorker(Reply&& reply, std::function<SyncReply()> work) {
  auto answer = std::make_shared<Reply>(std::move(reply));
  const bool posted = deps_.workers->post([this, answer, work = std::move(work)] {
    try {
      (*answer)(responseOf(work()));
    } catch (const std::exception& error) {
      LOG_ERROR << "sync request failed; type=" << typeid(error).name();
      (*answer)(responseOf(SyncReply::unavailable(SyncReply::envelope(deps_.clock->nowMs(), deps_.epoch))));
    }
  });
  if (!posted) (*answer)(responseOf(SyncReply::unavailable(SyncReply::envelope(deps_.clock->nowMs(), deps_.epoch))));
}

void SyncApi::hello(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->hello(callerOf(req, *deps_.auth));
  });
}

void SyncApi::push(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    TimeBudget budget(deps_.limits.pushWorkMs);
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->push(callerOf(req, *deps_.auth), req->body(), budget);
  });
}

void SyncApi::pull(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    if (std::optional<SyncReply> refused = versionRefusal(req)) return *refused;
    return deps_.service->pull(callerOf(req, *deps_.auth), req->body());
  });
}

std::optional<SyncReply> SyncApi::versionRefusal(const drogon::HttpRequestPtr& req) const {
  // Drogon presents a repeated header as its first value.
  return schemaRefusal(req->getHeader("sync-schema"), deps_.minSchema, deps_.clock->nowMs(), deps_.epoch);
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
  app.registerHandler(
      "/v1/sync/hello", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->hello(req, std::move(reply)); }, {drogon::Get});
  app.registerHandler(
      "/v1/sync/push", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->push(req, std::move(reply)); }, {drogon::Post});
  app.registerHandler(
      "/v1/sync/pull", [api](const drogon::HttpRequestPtr& req, SyncApi::Reply&& reply) { api->pull(req, std::move(reply)); }, {drogon::Post});
}

}
