#pragma once

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/ServerCall.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/Ids.h"
#include "platform/ports/ChangeFeed.h"
#include "platform/ports/Clock.h"
#include "platform/ports/FailureReporter.h"
#include "platform/ports/SyncStore.h"
#include "products/roadmap/application/RoadmapRows.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <json/json.h>

#include <functional>
#include <optional>
#include <stdexcept>
#include <string>

// Roadmap's one server-origin write path (Roadmap on the sync engine §7, engine.md §6.3): every write the server makes
// for a person — MCP's write tools, tending, the fork and the fork at sign-up — is a call of the door, whose admits are
// intents built under their scope's lock and admitted through roadmap's binding. A call with a requestId writes once:
// its reply is stored with it, and the same call sent again is answered that reply. Each call logs one
// `roadmap.server_call` line (operation, product, door, outcome or refusal code, duration) and reports an unexpected
// failure under that static name; neither names an id or a text.

namespace wm::roadmap {

// The engine could not take the call now: a scope stayed locked, the door's queue is full, or the call is still
// running under its requestId. Nothing was written; the same call may be sent again.
struct DoorBusy : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class RoadmapDoor {
public:
  RoadmapDoor(const sync::SyncCatalog& catalog, sync::SyncStore& store, sync::ChangeFeed& feed, sync::ServerClock& stamps,
              Clock& clock, FailureReporter& failures);
  ~RoadmapDoor();
  // Takes no more calls, runs the ones already queued and joins its workers.
  void stop();

  // Whether the engine serves roadmap's scopes here (ROADMAP_ENGINE_ENABLED): the door writes nothing where it does not.
  bool serving() const;
  const RoadmapRows& rows() const { return rows_; }

  class Call;
  // What a call's admit read and built under its scope's lock: the intent to admit, or nothing to admit nothing.
  using Build = std::function<std::optional<Json::Value>(sync::SyncTxn&)>;

  // One call of `account`'s, run on the door's workers from first admit to its reply: `body` admits its intents in order
  // and answers the call's reply, which a call with a requestId stores. A call sent again under that requestId with the
  // same operation and arguments is answered its stored reply and runs nothing; with others, `request-conflict`.
  // `operation` names the call in its write line and in its dedupe digest.
  Json::Value run(const UserId& account, const std::optional<std::string>& requestId, const std::string& operation,
                  const Json::Value& args, const std::function<Json::Value(Call&)>& body);

  // Who may write a roadmap, as the engine's tables hold it — its owner, its reach and where it sits — for a gate that
  // asks before any call, as a tend's does. Nothing for a roadmap that is not there.
  std::optional<TreeAccess> accessOf(const TreeId& tree) const;

  // A read of one consistent snapshot, on the caller's thread.
  template <typename Read>
  auto read(Read&& read) const {
    std::unique_ptr<sync::SyncTxn> txn = store_.begin(sync::TxnMode::snapshot);
    return read(*txn);
  }

private:
  const sync::SyncCatalog& catalog_;
  sync::SyncStore& store_;
  Clock& clock_;
  sync::PhysicalClock now_;
  sync::Admission admission_;
  RoadmapRows rows_;
  WorkerPool workers_{"roadmap-door", 4, 256};
};

// The admits of one call, in order. An admit's result is the engine's: `{s: ok, seq, write?}`, or `{s: refused, code}`,
// which ends the call's writes. A replayed admit answers the result stored for it.
class RoadmapDoor::Call {
public:
  // The call ran before and its reply was stored: the body stops and the door answers that reply.
  struct Answered {
    Json::Value reply;
  };

  Json::Value admit(Json::Value intent);
  Json::Value admitBuilt(Json::Value placeholder, const Build& build);
  const RoadmapRows& rows() const { return door_.rows_; }
  sync::Ms now() const { return now_; }

private:
  friend class RoadmapDoor;
  Call(RoadmapDoor& door, sync::ServerCall& call, sync::Ms now) : door_(door), call_(call), now_(now) {}
  Json::Value settle(const sync::AdmitOutcome& outcome);

  RoadmapDoor& door_;
  sync::ServerCall& call_;
  sync::Ms now_;
};

// What a server-origin intent of each scope kind is shaped as before its builder runs: admission takes its scope's
// locks and checks access by it, and the builder's intent replaces it.
Json::Value treePlaceholder(const std::string& tree);
Json::Value overlayPlaceholder(const std::string& tree);
Json::Value accountPlaceholder(const std::string& tree);

// An engine result that admitted its intent.
bool landed(const Json::Value& result);
std::string refusalOf(const Json::Value& result);

}
