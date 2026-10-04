#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Credentials.h"
#include "platform/ports/Clock.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace wm::sync {

struct SyncDeps {
  std::shared_ptr<SyncService> service;
  std::shared_ptr<AuthService> auth;
  std::shared_ptr<WorkerPool> workers;
  std::shared_ptr<Clock> clock;
  // The registry's minVersion: an older version is answered 426 (§9.6).
  std::int64_t minSchema = 1;
  // Read once at boot: a restore restarts the process. Only the 503 answered on the IO thread carries it.
  std::string epoch;
  Limits limits;
};

// §9.2–§9.4 over HTTP. A handler runs on the IO thread only long enough to post its work to the pool; at
// the pool's ceiling it answers 503 {error: "unavailable", retryAfterMs} without touching the database.
// On the worker, in §9.1's order: the Sync-Schema header, then the credentials every header line sends and the body as
// received, which the service checks. Bodies are written as JCS, so every number crosses the wire exactly as the
// digest hashed it (§6.12).
class SyncApi {
public:
  using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

  explicit SyncApi(SyncDeps deps);

  void hello(const drogon::HttpRequestPtr& req, Reply&& reply);
  void push(const drogon::HttpRequestPtr& req, Reply&& reply);
  void pull(const drogon::HttpRequestPtr& req, Reply&& reply);

private:
  // Posts `work` to the pool, which answers with `work`'s reply, or 503 when `work` throws. The pool refusing `work`
  // answers 503 as well.
  void onWorker(const drogon::HttpRequestPtr& req, Reply&& reply, std::function<SyncReply()> work);
  // §9.1's first check, on the version the header Sync-Schema carries.
  std::optional<SyncReply> versionRefusal(const drogon::HttpRequestPtr& req) const;
  // The credentials the request's header lines send as received, each token resolved to its session's account; the
  // access log learns the account they resolve to.
  Credential credentialOf(const drogon::HttpRequestPtr& req) const;

  SyncDeps deps_;
};

// Mounts /v1/sync/hello, /v1/sync/push and /v1/sync/pull.
void registerSyncRoutes(drogon::HttpAppFramework& app, const std::shared_ptr<SyncApi>& api);

// §9.1: the check every request passes first, on the registry version as Drogon presents its one carrier:
// hello, push and pull carry it in the header Sync-Schema, the live socket's upgrade in the query parameter
// `schema`, and a carrier that is absent presents "". 400 malformed unless it is a decimal integer, 426
// upgrade-required below `minSchema`.
std::optional<SyncReply> schemaRefusal(std::string_view version, std::int64_t minSchema, Ms serverTime, const std::string& epoch);

// A reply as the wire carries it: its status, and its body as JCS.
drogon::HttpResponsePtr responseOf(const SyncReply& reply);

}
