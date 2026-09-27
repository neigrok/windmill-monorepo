#include "platform/adapters/http/SyncApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/domain/sync/Jcs.h"

#include <drogon/utils/Utilities.h>

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
  // Drogon keeps the first value of a repeated header, so a repeated Sync-Schema reaches here as that one.
  const std::string& header = req->getHeader("sync-schema");
  const std::vector<std::string> versions = header.empty() ? std::vector<std::string>{} : std::vector<std::string>{header};
  return schemaRefusal(versions, deps_.minSchema, deps_.clock->nowMs(), deps_.epoch);
}

std::optional<SyncReply> schemaRefusal(const std::vector<std::string>& versions, std::int64_t minSchema, Ms serverTime,
                                       const std::string& epoch) {
  if (versions.size() != 1) return refusal(400, "malformed", serverTime, epoch);
  const std::string& version = versions.front();
  std::int64_t schema = 0;
  const auto [end, error] = std::from_chars(version.data(), version.data() + version.size(), schema);
  const bool decimal = !version.empty() && end == version.data() + version.size();
  if (!decimal || (error != std::errc{} && error != std::errc::result_out_of_range)) return refusal(400, "malformed", serverTime, epoch);
  // A decimal integer past int64 is past every version, and below minSchema only when it is negative.
  const bool below = error == std::errc::result_out_of_range ? version.front() == '-' : schema < minSchema;
  if (below) return refusal(426, "upgrade-required", serverTime, epoch);
  return std::nullopt;
}

std::vector<std::string> schemaParameters(std::string_view query) {
  std::vector<std::string> values;
  while (!query.empty()) {
    const std::size_t next = query.find('&');
    const std::string_view parameter = query.substr(0, next);
    const std::size_t equals = parameter.find('=');
    if (drogon::utils::urlDecode(parameter.substr(0, equals)) == "schema") {
      values.push_back(equals == std::string_view::npos ? "" : drogon::utils::urlDecode(parameter.substr(equals + 1)));
    }
    if (next == std::string_view::npos) break;
    query.remove_prefix(next + 1);
  }
  return values;
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
