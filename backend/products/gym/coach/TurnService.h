#pragma once

#include "platform/ai_installations/AiInstallations.h"
#include "platform/application/Entitlements.h"
#include "platform/application/Heartbeat.h"
#include "platform/application/WorkerPool.h"
#include "platform/ports/Clock.h"
#include "platform/ports/FailureReporter.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/coach/AbilityCatalog.h"
#include "products/gym/coach/CoachModel.h"
#include "products/gym/coach/Turn.h"
#include "products/gym/ports/GymWriteDoor.h"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <semaphore>
#include <string>

// The turn service (gym_coach.md §4.2, §4.5, §6.2): admits an open in the spec's order, runs the
// model loop on a worker with the phone as tool host, keeps each turn in memory for TURN_LINGER
// after it ends, and answers Stop, results and resumes against that registry. A heartbeat then drops
// the turn, and the Coach message of a bound seat that is still `running` ends through the write door.
// Nothing else here touches Postgres but the allowance reads the platform owns.
//
// Capacity (§7.3): the process runs at most `kVendorRounds` model calls at once, and a turn holds
// that slot only while its round streams — a turn waiting on its phone holds none, so a silent
// phone cannot answer `coach-busy` to everyone. `kMaxLiveTurns` bounds the turns alive in any
// state; both bounds refuse an open with `coach-busy`, and a round that finds no slot free within
// CALL_RESULT_TIMEOUT ends its turn `failed` on it.

namespace wm::gym::coach {

constexpr int kVendorRounds = 2;
constexpr int kMaxLiveTurns = 64;

// `turn` set: admitted, running or — `resumed` — already open under the same body. `code` set: refused,
// with `allowance` in the shared USD read contract when the allowance that refused it was read; null otherwise.
struct TurnAdmission {
  std::shared_ptr<Turn> turn;
  bool resumed = false;
  std::string code;
  Json::Value allowance;
};

class TurnService {
public:
  // `server` is the server executor the R2 shares of a bound seat run on, `door` where a dropped
  // turn's message ends. `installations` may be null where no USD allowances exist; an `anon` open is
  // then refused `anonymous_ai_unavailable`.
  TurnService(std::shared_ptr<CoachModel> model, const AbilityCatalog& catalog, ToolHost& server, GymWriteDoor& door,
              Entitlements& entitlements, std::shared_ptr<AiInstallations> installations, Clock& clock,
              int maxOutputTokens, std::shared_ptr<FailureReporter> failures,
              std::chrono::milliseconds resultTimeout = kCallResultTimeout);
  ~TurnService();
  // Arms the heartbeat that runs `sweep`.
  void start();
  void stop();

  // Whether this deployment can run a turn at all; the routes exist only where it can.
  bool configured() const;

  // §6.2 admission, then the loop on a worker. Reads the allowance: call it off the IO threads.
  TurnAdmission open(const TurnPrincipal& principal, TurnOpen open);
  // The principal's turn by id, or null — unknown, another principal's, or past its linger.
  std::shared_ptr<Turn> find(const TurnPrincipal& principal, const std::string& turnId);
  // §4.5: every turn past its linger is dropped, its Coach message ending first if it is still
  // `running`. A turn the door was too busy for stays for the next pass. Blocks on Postgres.
  void sweep();

private:
  void run(const std::shared_ptr<Turn>& turn);
  // The turn under the id while its linger has not passed. Called under the registry's lock.
  std::shared_ptr<Turn> standing(const std::string& turnId, std::uint64_t nowMs) const;
  // Whether the turn may go: its message took what it could, or the seat has no record on the server.
  bool endMessage(const Turn& turn);
  // §6.2 step 4: an empty admission, or the refusal of the allowance step.
  TurnAdmission allowanceRefusal(const TurnPrincipal& principal, const std::string& turnId) const;
  // The seat's USD allowance; nothing where durable allowances do not apply to it.
  std::optional<AiBudgetView> seatAllowance(const TurnPrincipal& principal) const;

  std::shared_ptr<CoachModel> model_;
  const AbilityCatalog& catalog_;
  ToolHost& server_;
  GymWriteDoor& door_;
  Entitlements& entitlements_;
  std::shared_ptr<AiInstallations> installations_;
  Clock& clock_;
  int maxOutputTokens_;
  std::shared_ptr<FailureReporter> failures_;
  std::chrono::milliseconds resultTimeout_;
  std::mutex registryMutex_;
  std::map<std::string, std::shared_ptr<Turn>> turns_;
  std::atomic<bool> stopping_{false};
  std::atomic<int> live_{0};
  std::counting_semaphore<kVendorRounds> vendorRounds_{kVendorRounds};
  WorkerPool workers_{"gym-coach-turn", kMaxLiveTurns, kMaxLiveTurns};
  Heartbeat sweeper_{"gym-coach-turns", "gym"};  // declared last: destructs first, before what a pass holds
};

}
