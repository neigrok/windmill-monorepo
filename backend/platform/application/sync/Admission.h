#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Wire.h"
#include "platform/ports/ChangeFeed.h"
#include "platform/ports/Clock.h"
#include "platform/ports/FailureReporter.h"
#include "platform/ports/SyncStore.h"

#include <json/json.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>

namespace wm::sync {

// §10.2: the server's one clock, actor `srv`. An admission mints on its own copy and folds the copy back
// when it commits, so a refused intent moves nothing. Admissions of one scope run one at a time under the
// scope's mutex, so each starts from its predecessor's stamps; admissions of different scopes may mint
// equal stamps, which never meet in one register.
class ServerClock {
public:
  explicit ServerClock(HlcClock::State state = {}) : state_(state) {}

  HlcClock copy() const;
  void fold(const HlcClock::State& state);
  HlcClock::State state() const;

private:
  mutable std::mutex mutex_;
  HlcClock::State state_;
};

// §10.2 physNow() on the server, the serverNow every push, pull and call reads: the wall clock, never below the
// greatest value it has returned in this process, so serverNow never steps back while the process runs.
class PhysicalClock final : public Clock {
public:
  explicit PhysicalClock(Clock& wall) : wall_(wall) {}
  std::uint64_t nowMs() override;

private:
  Clock& wall_;
  std::atomic<std::uint64_t> highest_{0};
};

// The in-process mutex of a scope (§6.1 step 3.1) not taken within LOCK_TIMEOUT_MS: transient (§6.6).
struct ScopeLockTimeout : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct ServerBuildAborted {
  std::exception_ptr error;
};

// §6.3: the k-th admit of a server-origin call that carries a requestId, and the call's digest. `looksUp` marks
// the call's first admit to run, which looks the call up in its own transaction.
struct CallPart {
  std::string requestId;
  int k = 1;
  Digest256 digest;
  bool looksUp = true;
};

// D-23.
struct ReplicaOrigin {
  UserId account;
  std::string replica;
  std::uint64_t n = 0;
  Digest256 digest;
};
struct ServerOrigin {
  UserId account;
  std::optional<CallPart> call;
};
using Origin = std::variant<ReplicaOrigin, ServerOrigin>;

// Committed: an ok, or a refusal step R stored for the replica or the call.
struct Admitted {
  Json::Value result;
};
// §6.1 step 3.3: under the replica row's lock, n was not the replica's next, and nothing was admitted. The push
// answers the turn as §6.2 step 4 does: another push answered n, the row is bound to another account, or n is
// past the next.
struct OutOfTurn {
  Turn turn = Turn::answered;
};
// §6.6: transient, or a fault below K_POISON; nothing was admitted. A transient failure waits `kTransientMs`.
struct Retry {
  static constexpr std::uint32_t kTransientMs = 1000;
  std::uint32_t afterMs = 0;
};
// §6.3's lookup answered the whole call without admitting: request-conflict, request-running, or the
// call's stored final result.
struct CallAnswered {
  Json::Value result;
};
// §6.3 step 2: the call's part k was stored before; its result stands, and this admit wrote nothing.
struct Replayed {
  Json::Value result;
};
using AdmitOutcome = std::variant<Admitted, OutOfTurn, Retry, CallAnswered, Replayed>;

// §6.1: admits one intent atomically, whatever its origin, and publishes what it committed (§6.8).
class Admission {
public:
  using ServerBuilder = std::function<std::optional<Json::Value>(SyncTxn&)>;
  Admission(const SyncCatalog& catalog, SyncStore& store, ChangeFeed& feed, ServerClock& clock, FailureReporter& failures,
            Limits limits = {});

  // One wire intent at `serverNow`, which a push reads once for all its intents (§6.1 step 2). Runs only
  // on a blocking thread (§6).
  AdmitOutcome admit(const Origin& origin, const Json::Value& intent, Ms serverNow);
  AdmitOutcome admitBuilt(const ServerOrigin&, const Json::Value& scopeIntent, Ms serverNow, const ServerBuilder&);

  const Limits& limits() const { return limits_; }

private:
  class Attempt;

  // §6.1 step 3.1: the catalog's scope mutex, held across commit and publish by every admission door.
  std::unique_lock<std::timed_mutex> takeStripe(const ScopeKey& scope);

  const SyncCatalog& catalog_;
  SyncStore& store_;
  ChangeFeed& feed_;
  ServerClock& clock_;
  FailureReporter& failures_;
  Limits limits_;
};

}
