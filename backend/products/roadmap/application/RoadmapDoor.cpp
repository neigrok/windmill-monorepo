#include "products/roadmap/application/RoadmapDoor.h"

#include "platform/application/WriteObservation.h"

#include <future>
#include <memory>

namespace wm::roadmap {

namespace {

// The reply a call stores, told apart from a refusal the engine answers a call with.
constexpr const char* kAnswered = "answered";

Json::Value placeholderOf(const std::string& scope, Json::Value delta) {
  Json::Value deltas(Json::arrayValue);
  deltas.append(std::move(delta));
  return intentIn(scope, std::move(deltas));
}

}

RoadmapDoor::RoadmapDoor(const sync::SyncCatalog& catalog, sync::SyncStore& store, sync::ChangeFeed& feed,
                         sync::ServerClock& stamps, Clock& clock, FailureReporter& failures)
    : catalog_(catalog), store_(store), clock_(clock), now_(clock), admission_(catalog, store, feed, stamps, failures),
      rows_(catalog, store) {}

RoadmapDoor::~RoadmapDoor() { stop(); }

void RoadmapDoor::stop() { workers_.stopAndJoin(); }

bool RoadmapDoor::serving() const { return catalog_.serves("roadmap"); }

Json::Value RoadmapDoor::run(const UserId& account, const std::optional<std::string>& requestId, const std::string& operation,
                             const Json::Value& args, const std::function<Json::Value(Call&)>& body) {
  const std::string door = currentWriteDoor();
  auto observation = std::make_shared<WriteObservation>("roadmap.server_call", "roadmap", door.empty() ? "background" : door);
  WriteContext context(*observation);
  auto answer = std::make_shared<std::promise<Json::Value>>();
  std::future<Json::Value> answered = answer->get_future();
  const bool posted = workers_.post([&, answer, observation] {
    WriteContext worker(*observation);
    try {
      sync::ServerCall server(admission_, store_, account, requestId, operation, args, "roadmap");
      Call call(*this, server, now_.nowMs());
      try {
        const Json::Value reply = body(call);
        Json::Value stored(Json::objectValue);
        stored["s"] = kAnswered;
        stored["reply"] = reply;
        server.finish(stored, now_.nowMs());
        observation->finish();
        answer->set_value(reply);
      } catch (const Call::Answered& replayed) {
        observation->finish("unchanged");
        answer->set_value(replayed.reply);
      }
    } catch (const DoorBusy&) {
      observation->finish("busy");
      answer->set_exception(std::current_exception());
    } catch (const std::exception& error) {
      observation->fail(error);
      answer->set_exception(std::current_exception());
    } catch (...) {
      observation->failUnknown();
      answer->set_exception(std::current_exception());
    }
  });
  if (!posted) {
    observation->finish("busy");
    throw DoorBusy("roadmap's door is not taking calls now");
  }
  return answered.get();
}

std::optional<TreeAccess> RoadmapDoor::accessOf(const TreeId& tree) const {
  return read([&](sync::SyncTxn& txn) -> std::optional<TreeAccess> {
    const TreeRows rows = rows_.tree(txn, tree.str(), std::nullopt);
    if (!rows.exists()) return std::nullopt;
    const AccountRows trees = rows_.account(txn, rows.owner());
    if (!trees.isAlive(tree.str())) return std::nullopt;
    return TreeAccess{rows.owner(), rows.reach(), TreeId{trees.rootOf(tree.str())}, trees.pathOf(tree.str())};
  });
}

Json::Value RoadmapDoor::Call::admit(Json::Value intent) { return settle(call_.admit(std::move(intent), now_)); }

Json::Value RoadmapDoor::Call::admitBuilt(Json::Value placeholder, const Build& build) {
  return settle(call_.admitBuilt(std::move(placeholder), now_, build));
}

Json::Value RoadmapDoor::Call::settle(const sync::AdmitOutcome& outcome) {
  if (const sync::Admitted* admitted = std::get_if<sync::Admitted>(&outcome)) return admitted->result;
  if (const sync::CallAnswered* stored = std::get_if<sync::CallAnswered>(&outcome)) {
    if (stored->result["s"] == kAnswered) throw Answered{stored->result["reply"]};
    const std::string code = refusalOf(stored->result);
    if (code == sync::code::requestRunning) throw DoorBusy("this call is still running under its requestId");
    return stored->result;
  }
  throw DoorBusy("the engine is busy");
}

Json::Value treePlaceholder(const std::string& tree) {
  Json::Value meta(Json::objectValue);
  meta["t"] = "meta";
  meta["id"] = "meta";
  meta["f"]["title"] = Json::Value(Json::arrayValue);
  meta["f"]["title"].append("");
  meta["f"]["title"].append(Json::Value());
  return placeholderOf("tree/" + tree, meta);
}

Json::Value overlayPlaceholder(const std::string& tree) {
  Json::Value mark(Json::objectValue);
  mark["status"] = "none";
  mark["outOfOrder"] = false;
  Json::Value progress(Json::objectValue);
  progress["t"] = "progress";
  progress["id"] = "placeholder";
  progress["f"]["mark"] = Json::Value(Json::arrayValue);
  progress["f"]["mark"].append(mark);
  progress["f"]["mark"].append(Json::Value());
  return placeholderOf("self/overlay/" + tree, progress);
}

Json::Value accountPlaceholder(const std::string& tree) {
  return placeholderOf("self/roadmap", Written{.type = "tree", .id = Json::Value(tree), .life = sync::LifeState::alive, .derived = true}.json());
}

bool landed(const Json::Value& result) { return result["s"] == "ok"; }

std::string refusalOf(const Json::Value& result) {
  if (landed(result)) return {};
  return result.get("code", "internal").asString();
}

}
