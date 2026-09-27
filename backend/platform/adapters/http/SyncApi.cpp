#include "platform/adapters/http/SyncApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/domain/sync/Jcs.h"

#include <trantor/utils/Logger.h>

#include <charconv>
#include <typeinfo>
#include <utility>

namespace wm::sync {

namespace {

constexpr std::uint32_t kUnavailableRetryMs = 1000;

SyncReply refusal(int status, const std::string& error, Ms serverTime, const std::string& epoch) {
  Json::Value body(Json::objectValue);
  body["serverTime"] = Json::UInt64(serverTime);
  body["epoch"] = epoch;
  body["error"] = error;
  return SyncReply{status, std::move(body)};
}

SyncReply unavailable(Ms serverTime, const std::string& epoch) {
  SyncReply reply = refusal(503, "unavailable", serverTime, epoch);
  reply.body["retryAfterMs"] = Json::UInt(kUnavailableRetryMs);
  return reply;
}

}

SyncApi::SyncApi(SyncDeps deps) : deps_(std::move(deps)) {}

void SyncApi::onWorker(Reply&& reply, std::function<SyncReply()> work) {
  auto answer = std::make_shared<Reply>(std::move(reply));
  const bool posted = deps_.workers->post([this, answer, work = std::move(work)] {
    try {
      (*answer)(responseOf(work()));
    } catch (const std::exception& error) {
      LOG_ERROR << "sync request failed; type=" << typeid(error).name();
      (*answer)(responseOf(unavailable(deps_.clock->nowMs(), deps_.epoch)));
    }
  });
  if (!posted) (*answer)(responseOf(unavailable(deps_.clock->nowMs(), deps_.epoch)));
}

void SyncApi::hello(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    const std::optional<UserId> caller = callerOf(req, *deps_.auth);
    if (std::optional<SyncReply> refused = schemaRefusal(req, deps_.minSchema, deps_.clock->nowMs(), deps_.epoch)) return *refused;
    return deps_.service->hello(caller);
  });
}

void SyncApi::push(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    TimeBudget budget(deps_.limits.pushWorkMs);
    const std::optional<UserId> caller = callerOf(req, *deps_.auth);
    if (std::optional<SyncReply> refused = schemaRefusal(req, deps_.minSchema, deps_.clock->nowMs(), deps_.epoch)) return *refused;
    if (req->body().size() > deps_.limits.pushMaxBytes) return refusal(413, "request-too-large", deps_.clock->nowMs(), deps_.epoch);
    Json::Value request;
    try {
      request = parseJson(req->body());
    } catch (const JsonError&) {
      return refusal(400, "malformed", deps_.clock->nowMs(), deps_.epoch);
    }
    return deps_.service->push(caller, request, budget);
  });
}

void SyncApi::pull(const drogon::HttpRequestPtr& req, Reply&& reply) {
  onWorker(std::move(reply), [this, req] {
    const std::optional<UserId> caller = callerOf(req, *deps_.auth);
    if (std::optional<SyncReply> refused = schemaRefusal(req, deps_.minSchema, deps_.clock->nowMs(), deps_.epoch)) return *refused;
    Json::Value request;
    try {
      request = parseJson(req->body());
    } catch (const JsonError&) {
      return refusal(400, "malformed", deps_.clock->nowMs(), deps_.epoch);
    }
    return deps_.service->pull(caller, request);
  });
}

std::optional<SyncReply> schemaRefusal(const drogon::HttpRequestPtr& req, std::int64_t minSchema, Ms serverTime, const std::string& epoch) {
  const std::string& header = req->getHeader("sync-schema");
  std::int64_t schema = 0;
  const auto [end, error] = std::from_chars(header.data(), header.data() + header.size(), schema);
  const bool decimal = !header.empty() && end == header.data() + header.size();
  if (!decimal || (error != std::errc{} && error != std::errc::result_out_of_range)) return refusal(400, "malformed", serverTime, epoch);
  // A decimal integer past int64 is past every version, and below minSchema only when it is negative.
  const bool below = error == std::errc::result_out_of_range ? header.front() == '-' : schema < minSchema;
  if (below) return refusal(426, "upgrade-required", serverTime, epoch);
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
