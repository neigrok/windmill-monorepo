#pragma once

#include "platform/ai_installations/AiInstallations.h"
#include "platform/application/Entitlements.h"
#include "platform/application/WorkerPool.h"
#include "platform/ports/Clock.h"
#include "platform/ports/FailureReporter.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/coach/AbilityCatalog.h"
#include "products/gym/coach/CoachModel.h"
#include "products/gym/coach/Turn.h"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <map>
#include <memory>
#include <mutex>
#include <string>

// The turn service (gym_coach.md §4.2, §4.5, §6.2): admits an open in the spec's order, runs the
// model loop on a bounded worker with the phone as tool host, keeps each turn in memory for
// TURN_LINGER after it ends, and answers Stop, results and resumes against that registry. Nothing
// here touches Postgres but the allowance reads the platform owns.

namespace wm::gym::coach {

// `turn` set: admitted, running or — `resumed` — already open under the same body. `code` set: refused.
struct TurnAdmission {
  std::shared_ptr<Turn> turn;
  bool resumed = false;
  std::string code;
};

class TurnService {
public:
  // `server` is the server executor the R2 shares of a bound seat run on. `installations` may be
  // null where no USD allowances exist; an `anon` open is then refused `anonymous_ai_unavailable`.
  TurnService(std::shared_ptr<CoachModel> model, const AbilityCatalog& catalog, ToolHost& server,
              Entitlements& entitlements, std::shared_ptr<AiInstallations> installations, Clock& clock,
              int maxOutputTokens, std::shared_ptr<FailureReporter> failures,
              std::chrono::milliseconds resultTimeout = kCallResultTimeout);
  ~TurnService();
  void stop();

  // Whether this deployment can run a turn at all; the routes exist only where it can.
  bool configured() const;

  // §6.2 admission, then the loop on a worker. Reads the allowance: call it off the IO threads.
  TurnAdmission open(const TurnPrincipal& principal, TurnOpen open);
  // The principal's turn by id, or null — unknown, another principal's, or dropped after its linger.
  std::shared_ptr<Turn> find(const TurnPrincipal& principal, const std::string& turnId);

  // The shared USD read contract for the seat, as `done.allowance` carries it; null where none applies.
  Json::Value allowance(const TurnPrincipal& principal) const;

private:
  void run(const std::shared_ptr<Turn>& turn);
  void sweep(std::uint64_t nowMs);
  std::string allowanceRefusal(const TurnPrincipal& principal, const std::string& turnId) const;

  std::shared_ptr<CoachModel> model_;
  const AbilityCatalog& catalog_;
  ToolHost& server_;
  Entitlements& entitlements_;
  std::shared_ptr<AiInstallations> installations_;
  Clock& clock_;
  int maxOutputTokens_;
  std::shared_ptr<FailureReporter> failures_;
  std::chrono::milliseconds resultTimeout_;
  std::mutex registryMutex_;
  std::map<std::string, std::shared_ptr<Turn>> turns_;
  std::atomic<int> running_{0};
  WorkerPool workers_{"gym-coach-turn", 2, 2};
};

}
