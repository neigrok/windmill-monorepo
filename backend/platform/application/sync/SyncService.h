#pragma once

#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/Ids.h"
#include "platform/ports/Clock.h"
#include "platform/ports/SyncStore.h"

#include <json/json.h>

#include <chrono>
#include <cstddef>
#include <optional>

namespace wm::sync {

// One answer of the sync endpoints (§9): an HTTP status and a body that always carries serverTime and epoch.
struct SyncReply {
  int status = 200;
  Json::Value body;
};

// §6.2 step 5: how long one push may keep admitting. The first intent always runs; after `admitted`
// admissions a spent budget answers retry {n, 0} naming the first unprocessed intent.
class PushBudget {
public:
  virtual ~PushBudget() = default;
  virtual bool spent(std::size_t admitted) = 0;
};

// The production budget: spent once an intent was admitted and `workMs` (Limits::pushWorkMs) have passed on a
// steady clock since the worker picked the push up and made the budget.
class TimeBudget final : public PushBudget {
public:
  explicit TimeBudget(Ms workMs);
  bool spent(std::size_t admitted) override;

private:
  std::chrono::steady_clock::time_point deadline_;
};

// §9.2 hello, §6.2 push and §6.7 pull over the engine's ports. Every method runs on a blocking thread (§6).
class SyncService {
public:
  SyncService(const SyncCatalog& catalog, SyncStore& store, Admission& admission, Clock& clock);

  SyncReply hello(const std::optional<UserId>& caller);
  SyncReply push(const std::optional<UserId>& caller, const Json::Value& request, PushBudget& budget);
  SyncReply pull(const std::optional<UserId>& caller, const Json::Value& request);

private:
  const SyncCatalog& catalog_;
  SyncStore& store_;
  Admission& admission_;
  Clock& clock_;
};

}
