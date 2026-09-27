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

#include <array>
#include <atomic>
#include <cstdint>
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
// The replica's last_n moved past n under the lock: another push answered n, whose stored result stands.
struct AlreadyAnswered {};
// §6.6: transient, or a fault below K_POISON; nothing was admitted.
struct Retry {
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
using AdmitOutcome = std::variant<Admitted, AlreadyAnswered, Retry, CallAnswered, Replayed>;

// §6.1: admits one intent atomically, whatever its origin, and publishes what it committed (§6.8).
class Admission {
public:
  Admission(const SyncCatalog& catalog, SyncStore& store, ChangeFeed& feed, ServerClock& clock, FailureReporter& failures,
            Limits limits = {});

  // One wire intent at `serverNow`, which a push reads once for all its intents (§6.1 step 2). Runs only
  // on a blocking thread (§6).
  AdmitOutcome admit(const Origin& origin, const Json::Value& intent, Ms serverNow);

  const Limits& limits() const { return limits_; }

private:
  class Attempt;

  // §6.1 step 3.1: one of 256 mutexes striped by the scope key's hash. An admit holds exactly one, so
  // striping costs an occasional false wait and never a deadlock.
  std::unique_lock<std::timed_mutex> takeStripe(const ScopeKey& scope);

  const SyncCatalog& catalog_;
  SyncStore& store_;
  ChangeFeed& feed_;
  ServerClock& clock_;
  FailureReporter& failures_;
  Limits limits_;
  std::array<std::timed_mutex, 256> stripes_;
};

}
