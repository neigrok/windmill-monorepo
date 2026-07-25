#include "adapters/http/HttpApi.h"

#include "adapters/http/Caller.h"
#include "adapters/http/JsonReply.h"
#include "adapters/json/SubgraphJson.h"
#include "adapters/json/TreeJson.h"
#include "application/ActivityFeed.h"
#include "application/TreeRoom.h"
#include "domain/Access.h"
#include "domain/Legend.h"
#include "domain/LooseGraph.h"

#include <algorithm>
#include <mutex>

namespace wm {

HttpApi::HttpApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                 std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis,
                 std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork)
    : registry_(std::move(registry)), trees_(std::move(trees)), progress_(std::move(progress)),
      ops_(std::move(ops)), genesis_(std::move(genesis)), auth_(std::move(auth)), fork_(std::move(fork)) {}

std::optional<UserId> HttpApi::callerOf(const drogon::HttpRequestPtr& req) const {
  return wm::callerOf(req, *auth_);
}

void HttpApi::getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  Json::Value body(Json::objectValue);
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      const std::optional<UserId>& owner = room.owner();
      // A private tree the caller can't read is 404 — body byte-identical to an absent tree,
      // so an id can't be probed for existence (reuse the found→404 branch below).
      if (!canRead(caller, owner, room.visibility())) {
        found = false;
      } else {
        body["seq"] = static_cast<Json::Int64>(room.head());
        body["data"] = toJson(room.snapshot());  // projected TreeData for the first paint
        Subgraph state;                           // the stamped lattice the client builds its TreeLattice from
        state.treeId = TreeId{treeId};
        state.frameId = "snapshot-" + std::to_string(room.head());
        state.actor = "srv";
        state.intent = SubgraphIntent::graft;
        state.graph = room.exportState();
        state.legend = room.exportLegend();
        body["state"] = toJson(state);
        // When the tree was planted (epoch ms) — the week-N progress card counts from here,
        // never the calendar week, so the client can't derive it from the document alone.
        body["createdAt"] = static_cast<Json::Int64>(room.createdAt());
        // The share flip reads these: the current visibility, and whether the caller owns it.
        body["visibility"] = toString(room.visibility());
        body["mine"] = caller && owner && *caller == *owner;
      }
    } catch (const std::exception&) {
      found = false;
    }
  }
  callback(found ? jsonResponse(body) : error(drogon::k404NotFound, "no such tree"));
}

void HttpApi::getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  Json::Value body;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      if (!canRead(caller, room.owner(), room.visibility())) found = false;  // structure is a read — gate it
      else body = toJson(room.diagnose());
    } catch (const std::exception&) {
      found = false;
    }
  }
  callback(found ? jsonResponse(body) : error(drogon::k404NotFound, "no such tree"));
}

void HttpApi::putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  TreeData data = treeFromJson(*json, TreeId{treeId});
  // The same ceiling the command path enforces (domain/Command.h). Without it this route admits
  // whatever fits in the body limit — tens of thousands of nodes — and every later read of that
  // tree pays for it.
  if (data.nodes.size() > kMaxNodes) {
    callback(error(drogon::k413RequestEntityTooLarge, "that tree has too many steps"));
    return;
  }
  GraphState state = LooseGraph(data, genesis_).exportState();  // seed full state from the posted tree

  Seq head = 0;
  LegendState legend;
  bool forbidden = false;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});
    if (existing && existing->owner && *existing->owner != *caller) {
      forbidden = true;  // someone else's tree — refuse the overwrite
    } else {
      registry_->evict(TreeId{treeId});  // drop any live room so the next open reloads this write
      head = existing ? existing->head : 0;
      // The legend is part of the document: honour a posted one; otherwise seed the three
      // defaults for a brand-new tree, or keep the existing legend on an overwrite.
      if (!data.kinds.empty()) legend = Legend(data.kinds, genesis_).exportState();
      else if (existing) legend = existing->legend;
      else legend = Legend::seededDefaults(genesis_).exportState();
      // The posted document is the new baseline, title included. A brand-new tree's title
      // starts stampless (the create-time baseline); an overwrite mints past the stored
      // register so it clears the repository's LWW guard — an overwrite means what it says.
      Lww<std::string> title{data.title, Hlc{}};
      if (existing) {
        HlcClock mint{std::string{TreeRoom::kServerActor}};
        mint.observe(existing->title.stamp);
        title.stamp = mint.tick(0);
      }
      trees_->save(TreeId{treeId}, state, legend, title, head);
      trees_->claim(TreeId{treeId}, *caller);  // first writer becomes the owner
    }
  }
  if (forbidden) {
    callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
    return;
  }

  data.kinds = Legend(legend).kinds();  // reflect the authoritative legend back to the client
  Json::Value body(Json::objectValue);
  body["seq"] = static_cast<Json::Int64>(head);
  body["data"] = toJson(data);
  callback(jsonResponse(body));
}

void HttpApi::forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to fork"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
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
  body["data"] = toJson(forked.data);  // includes the copied kinds, verbatim
  callback(jsonResponse(body, drogon::k201Created));
}

void HttpApi::getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  // A shared tree is shared to show its OWNER's journey — the whole point of the picture. So the
  // progress a reader gets follows ownership, not the caller: a visitor (anonymous or a non-owner)
  // sees the lit tree the share promised instead of an empty one, and the owner viewing their own
  // tree sees their own progress (they are the owner). Gated by canRead exactly like the structure
  // read, so a private tree's progress is 404 — byte-identical to absent, never leaked.
  std::optional<UserId> owner;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      if (!canRead(caller, room.owner(), room.visibility())) found = false;
      else owner = room.owner();
    } catch (const std::exception&) {
      found = false;
    }
  }
  if (!found) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  // The DB load runs OUTSIDE the room strand — never hold a room's lock across a Postgres call. An
  // unclaimed (ownerless) tree has no server-side progress to show, so it stays empty.
  Progress progress = owner ? progress_->load(TreeId{treeId}, *owner) : Progress{};
  callback(jsonResponse(toJson(progress)));
}

void HttpApi::getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  Seq since = 0;
  std::size_t limit = 100;
  try {
    if (!req->getParameter("since").empty()) since = std::stoull(req->getParameter("since"));
    if (!req->getParameter("limit").empty()) limit = std::min<std::size_t>(std::stoul(req->getParameter("limit")), 500);
  } catch (const std::exception&) {
    callback(error(drogon::k400BadRequest, "since and limit must be numbers"));
    return;
  }

  std::optional<UserId> caller = callerOf(req);
  TreeData current;
  bool found = true;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    try {
      TreeRoom& room = registry_->open(TreeId{treeId});
      if (!canRead(caller, room.owner(), room.visibility())) found = false;  // the feed exposes structure too
      else current = room.snapshot();
    } catch (const std::exception&) {
      found = false;
    }
  }
  if (!found) {
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
