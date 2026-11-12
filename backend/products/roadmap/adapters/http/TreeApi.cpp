#include "products/roadmap/adapters/http/TreeApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Guides.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <mutex>

namespace wm {

TreeApi::TreeApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                 std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis,
                 std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork, std::shared_ptr<Clock> clock)
    : registry_(std::move(registry)), trees_(std::move(trees)), progress_(std::move(progress)),
      ops_(std::move(ops)), genesis_(std::move(genesis)), auth_(std::move(auth)), fork_(std::move(fork)),
      clock_(std::move(clock)) {}

std::optional<UserId> TreeApi::callerOf(const drogon::HttpRequestPtr& req) const {
  return wm::callerOf(req, *auth_);
}

// An absent tree, one this caller may not read, and an infrastructure failure all answer false,
// so all three become one 404 and a failure never tells a stranger which ids are real. The failure
// alone files an Issue, under one static operation. `read` runs under the strand.
bool TreeApi::readRoom(const std::string& treeId, const std::optional<UserId>& caller,
                       const std::function<void(TreeRoom&)>& read) {
  WriteObservation observation{"roadmap.tree.read", "roadmap", "rest"};
  std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
  try {
    // Authorize on the stored row BEFORE materializing a room: open() pins the whole lattice in
    // memory.
    const std::optional<TreeAccess> access = registry_->accessOf(TreeId{treeId});
    TreeRoom* room = access && canRead(caller, access->owner, access->visibility) ? registry_->open(TreeId{treeId})
                                                                                  : nullptr;
    if (room) read(*room);
    observation.skip();  // a read that does not fail leaves no completion line
    return room != nullptr;
  } catch (const std::exception& error) {
    observation.fail(error);
    return false;
  }
}

void TreeApi::getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  Json::Value body(Json::objectValue);
  TreeData data;
  bool mine = false;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        mine = canWrite(caller, room.owner());
        data = room.snapshot();
        body["seq"] = static_cast<Json::Int64>(room.head());
        body["data"] = toJson(mine ? data : readerView(data));
        Subgraph state;
        state.treeId = TreeId{treeId};
        state.frameId = "snapshot-" + std::to_string(room.head());
        state.actor = "srv";
        state.intent = SubgraphIntent::graft;
        state.graph = mine ? room.exportState() : readerView(room.exportState());
        state.legend = room.exportLegend();
        body["state"] = toJson(state);
        // Epoch ms.
        body["createdAt"] = static_cast<Json::Int64>(room.createdAt());
        body["visibility"] = toString(room.visibility());
        body["mine"] = mine;
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (!mine) {
    callback(jsonResponse(body));
    return;
  }
  // What each pointer comes to, for the tree's writer alone and OUTSIDE the room strand, as getProgress loads.
  WriteObservation observation{"roadmap.tree.follow", "roadmap", "rest"};
  try {
    const OpenedTrees opened(trees_->openedFrom(*caller, treesOpenedBy(data)));
    body["opens"] = toJson(opened.openings(data), opened.leadingBackTo(data.id));
    observation.skip();
  } catch (const std::exception& failure) {
    // Not an absent tree: a 5xx is what a client reports and retries.
    observation.fail(failure);
    callback(error(drogon::k503ServiceUnavailable, "the trees this tree opens could not be read — try again",
                   "opens-unavailable"));
    return;
  }
  callback(jsonResponse(body));
}

void TreeApi::getGuides(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  const std::optional<UserId> caller = callerOf(req);
  Guide own;
  bool mine = false;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        mine = canWrite(caller, room.owner());
        // A guide is the caller's own only on a tree they can write, and not when a fork copied it from someone else's.
        own = Guide{TreeId{treeId}, room.title().value, room.guide().value, mine && !room.guideInherited()};
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  Json::Value body(Json::objectValue);
  if (!mine) {
    body["guides"] = toJson(guidesFor({}, own));
    callback(jsonResponse(body));
    return;
  }
  // The trees above are read for the tree's writer alone and OUTSIDE the room strand, as getProgress loads.
  WriteObservation observation{"roadmap.tree.guides", "roadmap", "rest"};
  try {
    body["guides"] = toJson(guidesFor(trees_->guidedTreesAbove(*caller, TreeId{treeId}), own));
    observation.skip();
  } catch (const std::exception& failure) {
    // Not an absent tree: a 5xx is what a client reports and retries.
    observation.fail(failure);
    callback(error(drogon::k503ServiceUnavailable, "the guides of the trees above this one could not be read — try again",
                   "guides-unavailable"));
    return;
  }
  callback(jsonResponse(body));
}

void TreeApi::getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  const std::optional<UserId> caller = callerOf(req);
  TreeDiagnostics graph;
  std::optional<TreeData> toFollow;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        graph = room.diagnose();
        if (canWrite(caller, room.owner())) toFollow = room.snapshot();
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (!toFollow) {
    callback(jsonResponse(toJson(graph)));
    return;
  }
  // The pointers are followed for the tree's writer alone and OUTSIDE the room strand, as getProgress loads. A follow
  // that fails leaves the graph's diagnostics and a flag: the graph is still told.
  Json::Value body;
  WriteObservation observation{"roadmap.diagnostics.follow", "roadmap", "rest"};
  try {
    const OpenedTrees opened(trees_->openedFrom(*caller, treesOpenedBy(*toFollow)));
    observation.skip();
    body = toJson(graph, opened.diagnose(*toFollow));
  } catch (const std::exception& failure) {
    observation.fail(failure);
    body = toJson(graph);
    body["pointerDiagnosticsUnavailable"] = true;
  }
  callback(jsonResponse(body));
}

void TreeApi::putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // jsoncpp throws on a keyed read of an array or a scalar, so a non-object root is refused first.
  if (!json || !json->isObject()) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  std::optional<TreeData> data = treeFromJson(*json, TreeId{treeId});
  if (!data) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  if (std::optional<Admission> refusal = admit(*data)) {
    const bool tooLarge = refusal->verdict == Admission::Verdict::tooLarge;
    callback(error(tooLarge ? drogon::k413RequestEntityTooLarge : drogon::k400BadRequest, refusal->reason));
    return;
  }
  // The whole decision runs under the tree's strand; the callback fires outside the lock.
  drogon::HttpResponsePtr reply = [&]() -> drogon::HttpResponsePtr {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    // Judge on the two authorization columns alone and touch nothing until they say yes: an
    // eviction above this gate would close the live room of whatever id a stranger names.
    std::optional<TreeAccess> access = trees_->loadAccess(TreeId{treeId});
    // Unreadable answers "no such tree": a refusal must never state that a private id is taken.
    if (access && !canRead(caller, access->owner, access->visibility))
      return error(drogon::k404NotFound, "no such tree");
    if (access) {
      if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, access->owner))
        return error(drogon::k403Forbidden, sentenceOf(*refusal), codeOf(*refusal));
    }

    // A PUT to an id no row holds CREATES the tree, so it must be well-formed; an existing tree
    // keeps whatever id it has.
    if (!access && !wellFormedTreeId(treeId))
      return error(drogon::k400BadRequest, "id must be t_ followed by 16 lowercase hex characters", "bad-id");

    // Flush and close any live room, THEN read the row that flush just wrote: reading it earlier
    // rewinds head_seq under the op log.
    registry_->evict(TreeId{treeId});
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});

    // A save GROWS the stored lattice, so the ceiling is read off what the tree would HOLD.
    if (existing) {
      if (std::optional<Admission> refusal = admit(LooseGraph(existing->state), *data)) {
        const bool tooLarge = refusal->verdict == Admission::Verdict::tooLarge;
        return error(tooLarge ? drogon::k413RequestEntityTooLarge : drogon::k400BadRequest, refusal->reason);
      }
    }

    // A document that creates the tree adds its steps now. One joined into a standing tree takes
    // the genesis stamp, which every live edit outranks.
    const Hlc plantedAt = existing ? genesis_ : Hlc{clock_->nowMs(), 0, std::string{TreeRoom::kServerActor}};
    GraphState state = LooseGraph(*data, plantedAt).exportState();

    LegendState legend;
    if (!data->kinds.empty()) legend = Legend(data->kinds, genesis_).exportState();
    else if (existing) legend = existing->legend;
    else legend = Legend::seededDefaults(genesis_).exportState();

    if (!existing) {
      try {
        trees_->create(TreeId{treeId}, state, legend, data->title, *caller);
      } catch (const DuplicateTree&) {
        // Lost an insert race, or a soft-deleted row still holds the id.
        return error(drogon::k409Conflict, "a tree with that id already exists");
      }
    } else {
      // Minted past the stored register so it clears the repository's LWW guard.
      HlcClock mint{std::string{TreeRoom::kServerActor}};
      mint.observe(existing->title.stamp);
      trees_->save(TreeId{treeId}, state, legend, Lww<std::string>{data->title, mint.tick(0)},
                   existing->guide, existing->head);
    }

    // A document never sets the guide, so the answer states the one the tree holds.
    if (existing) data->guide = existing->guide.value;
    data->kinds = Legend(legend).kinds();
    Json::Value body(Json::objectValue);
    body["seq"] = static_cast<Json::Int64>(existing ? existing->head : 0);
    body["data"] = toJson(*data);
    return jsonResponse(body);
  }();
  callback(reply);
}

void TreeApi::forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to fork"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (json && !json->isObject()) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  std::string newId = json ? json->get("id", "").asString() : "";      // optional — minted when absent
  std::string title = json ? json->get("title", "").asString() : "";   // optional — inherited when absent
  if (!newId.empty() && !wellFormedTreeId(newId)) {
    callback(error(drogon::k400BadRequest, "id must be t_ followed by 16 lowercase hex characters", "bad-id"));
    return;
  }

  ForkService::Result forked = fork_->fork(TreeId{treeId}, newId, title, *caller);
  if (forked.outcome == ForkService::Outcome::noSource) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (forked.outcome == ForkService::Outcome::conflict) {
    callback(error(drogon::k409Conflict, "a tree with that id already exists"));
    return;
  }

  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(0);
  body["data"] = toJson(forked.data);
  callback(jsonResponse(body, drogon::k201Created));
}

void TreeApi::getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  // Progress follows OWNERSHIP, not the caller, and is gated by canRead.
  std::optional<UserId> owner;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) { owner = room.owner(); })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  // The DB load runs OUTSIDE the room strand: never hold a room's lock across a Postgres call.
  Progress progress = owner ? progress_->load(TreeId{treeId}, *owner) : Progress{};
  callback(jsonResponse(toJson(progress)));
}

void TreeApi::getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  Seq since = 0;
  std::size_t limit = 100;
  try {
    if (!req->getParameter("since").empty()) since = std::stoull(req->getParameter("since"));
    if (!req->getParameter("limit").empty()) limit = std::min<std::size_t>(std::stoul(req->getParameter("limit")), 500);
  } catch (const std::exception&) {
    callback(error(drogon::k400BadRequest, "since and limit must be numbers"));
    return;
  }

  TreeData current;
  if (!readRoom(treeId, callerOf(req), [&](TreeRoom& room) { current = room.snapshot(); })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }

  std::vector<ActivityEvent> events = activityFeed(current, ops_->since(TreeId{treeId}, since), limit);

  Json::Value list(Json::arrayValue);
  for (const ActivityEvent& event : events) {
    Json::Value item(Json::objectValue);
    item["id"] = std::to_string(event.seq);
    item["seq"] = static_cast<Json::Int64>(event.seq);
    item["at"] = static_cast<Json::Int64>(event.at);
    item["actor"] = event.actor;
    item["verb"] = event.verb;
    if (!event.node.empty()) item["nodeId"] = event.node.str();
    item["label"] = event.label;
    item["kind"] = event.kind;
    item["summary"] = event.summary;
    list.append(item);
  }
  Json::Value body(Json::objectValue);
  body["events"] = list;
  callback(jsonResponse(body));
}

}
