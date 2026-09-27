#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncService.h"
#include "platform/ports/Clock.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace wm::sync {

struct SyncDeps {
  std::shared_ptr<SyncService> service;
  std::shared_ptr<AuthService> auth;
  std::shared_ptr<WorkerPool> workers;
  std::shared_ptr<Clock> clock;
  // The registry's minVersion: an older Sync-Schema is answered 426 (§9.6).
  std::int64_t minSchema = 1;
  // Read once at boot: a restore restarts the process. Only the 503 answered on the IO thread carries it.
  std::string epoch;
  Limits limits;
};

// §9.2–§9.4 over HTTP. A handler runs on the IO thread only long enough to post its work to the pool; at
// the pool's ceiling it answers 503 {error: "unavailable", retryAfterMs} without touching the database.
// On the worker: the caller (the session cookie or a Bearer token), the Sync-Schema header, then the body.
// Bodies are written as JCS, so every number crosses the wire exactly as the digest hashed it (§6.12).
class SyncApi {
public:
  using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

  explicit SyncApi(SyncDeps deps);

  void hello(const drogon::HttpRequestPtr& req, Reply&& reply);
  void push(const drogon::HttpRequestPtr& req, Reply&& reply);
  void pull(const drogon::HttpRequestPtr& req, Reply&& reply);

private:
  // Posts `work` to the pool, answering 503 when the pool refuses it. `work` answers the reply itself.
  void onWorker(Reply&& reply, std::function<SyncReply()> work);
  // The Sync-Schema check every request passes first (§9.1): 400 when missing, 426 when older than minSchema.
  std::optional<SyncReply> schemaRefusal(const drogon::HttpRequestPtr& req) const;

  SyncDeps deps_;
};

// Mounts /v1/sync/hello, /v1/sync/push and /v1/sync/pull.
void registerSyncRoutes(drogon::HttpAppFramework& app, const std::shared_ptr<SyncApi>& api);

}
