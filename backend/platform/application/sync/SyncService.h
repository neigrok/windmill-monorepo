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
#include <string>
#include <string_view>

namespace wm::sync {

// One answer of the sync endpoints (§9): an HTTP status and a body that always carries serverTime and epoch.
struct SyncReply {
  int status = 200;
  Json::Value body;

  // §9.1: the part of every answer's body that is serverTime and epoch.
  static Json::Value envelope(Ms serverTime, const std::string& epoch);
  // §9.6: an answer that is its error code alone.
  static SyncReply refused(int status, Json::Value envelope, const std::string& error);
  // §6.6 and §9.6: 503 unavailable, to be retried after Retry::kTransientMs.
  static SyncReply unavailable(Json::Value envelope);
};

// §6.2 step 5: how long one push may keep admitting. The first intent always runs; after `admitted`
// admissions a spent budget answers retry {n, 0} naming the first unprocessed intent. An answer read back from
// sync_results is not an admission.
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

// §9.2 hello, §6.2 push and §6.7 pull over the engine's ports, each from its caller and its body as received.
// A request's registry version is checked before it reaches the service (§9.1); push and pull check the rest
// of §9.1's envelope here, in its order. Every method runs on a blocking thread (§6).
class SyncService {
public:
  SyncService(const SyncCatalog& catalog, SyncStore& store, Admission& admission, Clock& clock);

  SyncReply hello(const std::optional<UserId>& caller);
  SyncReply push(const std::optional<UserId>& caller, std::string_view body, PushBudget& budget);
  SyncReply pull(const std::optional<UserId>& caller, std::string_view body);

private:
  const SyncCatalog& catalog_;
  SyncStore& store_;
  Admission& admission_;
  Clock& clock_;
};

}
