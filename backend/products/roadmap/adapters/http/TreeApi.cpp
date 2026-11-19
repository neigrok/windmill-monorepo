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
#include "products/roadmap/domain/OpenedTrees.h"

#include <algorithm>
#include <mutex>

namespace wm {

TreeApi::TreeApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                 std::shared_ptr<OwnerProgress> progress, std::shared_ptr<OpLog> ops, std::shared_ptr<AuthService> auth,
                 std::shared_ptr<TreeForks> fork, std::shared_ptr<EngineReadModels> engine)
    : registry_(std::move(registry)), trees_(std::move(trees)), progress_(std::move(progress)),
      ops_(std::move(ops)), auth_(std::move(auth)), fork_(std::move(fork)), engine_(std::move(engine)) {}

std::optional<UserId> TreeApi::callerOf(const drogon::HttpRequestPtr& req) const {
  return wm::callerOf(req, *auth_);
}

// An absent tree, one this caller may not read, and an infrastructure failure all answer false,
// so all three become one 404 and a failure never tells a stranger which ids are real. The failure
// alone files an Issue, under one static operation. `read` runs under the strand.
bool TreeApi::readRoom(const std::string& treeId, const std::optional<UserId>& caller,
                       const std::function<void(TreeRoom&)>& read) {
  WriteObservation observation{"roadmap.tree.read", "roadmap", "rest"};
  // The reads made for it are of its request: a failure one of them reports is the request's one Issue.
  WriteContext context{observation};
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

bool TreeApi::readRecords(const std::string& treeId, const std::optional<UserId>& caller,
                          const std::function<void(const ReadableRoadmap&)>& read) {
  WriteObservation observation{"roadmap.tree.read", "roadmap", "rest"};
  WriteContext context{observation};
  try {
    const std::optional<ReadableRoadmap> roadmap = engine_->open(TreeId{treeId}, caller);
    if (roadmap) read(*roadmap);
    observation.skip();
    return roadmap.has_value();
  } catch (const std::exception& error) {
    observation.fail(error);
    return false;
  }
}

std::optional<Place> TreeApi::placeOf(const TreeId& tree) {
  WriteObservation observation{"roadmap.tree.place", "roadmap", "rest"};
  try {
    std::optional<Place> place = trees_->placeOf(tree);
    observation.skip();
    return place;
  } catch (const std::exception& failure) {
    observation.fail(failure);
    return std::nullopt;
  }
}

void TreeApi::getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  Json::Value body(Json::objectValue);
  TreeData data;
  bool mine = false;
  std::optional<UserId> owner;
  std::optional<Place> place;
  std::map<NodeId, TreeId> subtrees;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        mine = canWrite(caller, room.owner());
        owner = room.owner();
        data = room.snapshot();
        subtrees = room.subtrees();
        // A root's place is its own; a subtree's way down from its root is read once the strand is released.
        if (!room.parent()) place = Place{data.title, room.title().stamp, room.root(), std::nullopt, {}, 0};
        body["seq"] = static_cast<Json::Int64>(room.head());
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
  // A subtree's name and its way down are read through its parents, and a failure answers as the room read's does.
  if (!place) place = placeOf(TreeId{treeId});
  if (!place) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  data.title = place->title;
  const Json::Value where = toJson(*place);
  for (const std::string& key : where.getMemberNames()) body[key] = where[key];

  // What each step's subtree, and for the tree's writer each pointer, comes to, off one follow of the owner's trees made
  // OUTSIDE the room strand, as getProgress loads. The writer follows every tree the tree's steps open; a reader the
  // subtrees alone, under the budget and cool-off every reader's follow of an owner shares (OwnerProgress), and is shown
  // the subtrees unread when the owner cannot be followed.
  if (!mine) {
    std::optional<OpenedTrees> opened;
    if (owner && !subtrees.empty()) {
      FollowTally tally;
      opened = progress_->followed(*owner, treesOpenedBy(subtrees), kReaderFollowBudget, "rest", tally);
    }
    body["data"] = toJson(readerView(data), ownedSubtrees(subtrees, opened));
    callback(jsonResponse(body));
    return;
  }
  WriteObservation observation{"roadmap.tree.follow", "roadmap", "rest"};
  try {
    const std::optional<OpenedTrees> opened(std::in_place, trees_->openedFrom(*caller, treesOpenedBy(data)));
    body["data"] = toJson(data, ownedSubtrees(subtrees, opened));
    body["opens"] = toJson(opened->openings(data), opened->leadingBackTo(data.id));
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
  bool subtree = false;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        mine = canWrite(caller, room.owner());
        subtree = room.parent().has_value();
        // A guide is the caller's own only on a tree they can write, and not when a fork copied it from someone else's.
        own = Guide{TreeId{treeId}, room.title().value, room.guide().value, mine && !room.guideInherited()};
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  // A subtree is named by its owning step's label, read through its parent as the tree read reads it.
  if (subtree) {
    const std::optional<Place> place = placeOf(TreeId{treeId});
    if (!place) {
      callback(error(drogon::k404NotFound, "no such tree"));
      return;
    }
    own.title = place->title;
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
  std::optional<std::map<NodeId, TreeId>> pointers;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        graph = room.diagnose();
        if (canWrite(caller, room.owner())) pointers = room.pointers();
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (!pointers) {
    callback(jsonResponse(toJson(graph)));
    return;
  }
  // The pointers are followed for the tree's writer alone and OUTSIDE the room strand, as getProgress loads. A follow
  // that fails leaves the graph's diagnostics and a flag: the graph is still told.
  Json::Value body;
  WriteObservation observation{"roadmap.diagnostics.follow", "roadmap", "rest"};
  try {
    const OpenedTrees opened(trees_->openedFrom(*caller, treesOpenedBy(*pointers)));
    body = toJson(graph, opened.diagnose(TreeId{treeId}, *pointers));
    observation.skip();
  } catch (const std::bad_alloc&) {
    throw;
  } catch (const std::exception& failure) {
    observation.fail(failure);
    body = toJson(graph);
    body["pointerDiagnosticsUnavailable"] = true;
  }
  callback(jsonResponse(body));
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
  // The name the copy is asked to carry is held to the bounds a document's title is, before the source is touched.
  if (std::optional<Admission> refusal = admitTitle(title)) {
    callback(error(drogon::k400BadRequest, refusal->reason));
    return;
  }

  // A fork sent with a request key — `requestId` in the body or the Idempotency-Key header — is one fork however often
  // it is sent: a resend after a lost answer or a cut-short copy answers the same new roadmap.
  std::string requestKey = json ? json->get("requestId", "").asString() : "";
  if (requestKey.empty()) requestKey = req->getHeader("Idempotency-Key");
  if (requestKey.size() > 128 || requestKey.find_first_of(std::string("#\0", 2)) != std::string::npos) {
    callback(error(drogon::k400BadRequest, "requestId must be at most 128 characters, holding no \"#\"", "bad-request-id"));
    return;
  }

  TreeForks::Result forked = fork_->fork(TreeId{treeId}, newId, title, *caller,
                                         requestKey.empty() ? std::nullopt : std::optional<std::string>(requestKey));
  if (forked.outcome == TreeForks::Outcome::busy) {
    callback(error(drogon::k503ServiceUnavailable, "the fork could not be made just now; send it again", "busy"));
    return;
  }
  if (forked.outcome == TreeForks::Outcome::requestConflict) {
    callback(error(drogon::k409Conflict, "this requestId was sent before for another fork", "request-conflict"));
    return;
  }
  if (forked.outcome == TreeForks::Outcome::noSource) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (forked.outcome == TreeForks::Outcome::conflict) {
    callback(error(drogon::k409Conflict, "a tree with that id already exists"));
    return;
  }
  if (forked.outcome == TreeForks::Outcome::notARoot) {
    callback(jsonResponse(toJson(*forked.notARoot, "a subtree is copied with its root, so fork the root"),
                          drogon::k409Conflict));
    return;
  }

  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(0);
  body["data"] = toJson(forked.data);
  callback(jsonResponse(body, drogon::k201Created));
}

void TreeApi::getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  const std::optional<Json::Value> answer = progressAnswer(treeId, callerOf(req));
  if (!answer) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  callback(jsonResponse(*answer));
}

std::optional<Json::Value> TreeApi::progressAnswer(const std::string& treeId, const std::optional<UserId>& caller) {
  if (engine_) {
    ShownProgress shown;
    if (!readRecords(treeId, caller, [&](const ReadableRoadmap& roadmap) { shown = engine_->progress(roadmap); })) return std::nullopt;
    return toJson(shown);
  }
  // Progress follows OWNERSHIP, not the caller, and is gated by canRead.
  std::optional<UserId> owner;
  bool mine = false;
  std::map<NodeId, StampedPointer> pointers;
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        owner = room.owner();
        mine = canWrite(caller, owner);
        // A writer reads the marks as stored, so only a reader's answer is judged against the tree's pointers.
        if (!mine) pointers = room.stampedPointers();
      }))
    return std::nullopt;
  if (!owner) return toJson(Progress{});
  // The marks are loaded and the pointers followed OUTSIDE the room strand: never hold a room's lock across a
  // Postgres call. A reader is shown the owner's derived completion (domain readerView); the tree's writer, whose
  // view derives it again from the tree's `opens`, the marks as stored.
  const TreeId tree{treeId};
  if (mine) return toJson(progress_->stored(tree, *owner));
  const ShownToReaders shown =
      progress_->shownToReaders({OwnersTrees{*owner, {{tree, std::move(pointers)}}}}, kReaderFollowBudget, "rest");
  return toJson(shown.progress.at(tree));
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
  const std::optional<Json::Value> answer = activityAnswer(treeId, callerOf(req), since, limit);
  if (!answer) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  callback(jsonResponse(*answer));
}

std::optional<Json::Value> TreeApi::activityAnswer(const std::string& treeId, const std::optional<UserId>& caller, Seq since,
                                                   std::size_t limit) {
  std::vector<ActivityEvent> events;
  if (engine_) {
    if (!readRecords(treeId, caller, [&](const ReadableRoadmap& roadmap) { events = engine_->activity(roadmap, since, limit); }))
      return std::nullopt;
  } else {
    TreeData current;
    if (!readRoom(treeId, caller, [&](TreeRoom& room) { current = room.snapshot(); })) return std::nullopt;
    events = activityFeed(current, ops_->since(TreeId{treeId}, since), limit);
  }

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
  return body;
}

}
