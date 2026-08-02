#include "products/roadmap/adapters/http/HttpApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/roadmap/adapters/json/SubgraphJson.h"
#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/ActivityFeed.h"
#include "products/roadmap/application/TreeRoom.h"
#include "platform/domain/Access.h"
#include "products/roadmap/domain/Legend.h"
#include "products/roadmap/domain/LooseGraph.h"

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
      TreeRoom* room = registry_->open(TreeId{treeId});
      // Absent (null) or a private tree the caller can't read is 404 — body byte-identical, so an
      // id can't be probed for existence. An infrastructure failure still throws to the catch,
      // which also answers 404: masked, not leaked (a message with a host never reaches the client).
      if (!room || !canRead(caller, room->owner(), room->visibility())) {
        found = false;
      } else {
        const std::optional<UserId>& owner = room->owner();
        body["seq"] = static_cast<Json::Int64>(room->head());
        body["data"] = toJson(room->snapshot());  // projected TreeData for the first paint
        Subgraph state;                            // the stamped lattice the client builds its TreeLattice from
        state.treeId = TreeId{treeId};
        state.frameId = "snapshot-" + std::to_string(room->head());
        state.actor = "srv";
        state.intent = SubgraphIntent::graft;
        state.graph = room->exportState();
        state.legend = room->exportLegend();
        body["state"] = toJson(state);
        // When the tree was planted (epoch ms) — the week-N progress card counts from here,
        // never the calendar week, so the client can't derive it from the document alone.
        body["createdAt"] = static_cast<Json::Int64>(room->createdAt());
        // The share flip reads these: the current visibility, and whether this tree is the
        // caller's to change — which is canWrite exactly, so the client's "mine" and the
        // server's write gate can never drift apart into a button that refuses itself.
        body["visibility"] = toString(room->visibility());
        body["mine"] = canWrite(caller, owner);
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
      TreeRoom* room = registry_->open(TreeId{treeId});
      if (!room || !canRead(caller, room->owner(), room->visibility())) found = false;  // absent or gated
      else body = toJson(room->diagnose());
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

  // The whole decision runs under the tree's strand and hands back the reply it earned, so it
  // reads top to bottom as one fail-fast pipeline — and the callback fires outside the lock.
  drogon::HttpResponsePtr reply = [&]() -> drogon::HttpResponsePtr {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
    // Judge first, on the two authorization columns alone, and touch NOTHING until they say yes.
    // An eviction placed above this gate would flush and close the live room of whatever id a
    // stranger cared to name — a refusal that costs its victim a cold reopen, on a tree the
    // caller may not even be allowed to read.
    std::optional<TreeAccess> access = trees_->loadAccess(TreeId{treeId});
    // A tree the caller cannot read is answered "no such tree", the same sentence every other
    // read on this surface gives — a refusal must never state that a private id belongs to
    // someone. A readable tree the caller does not own names the truth, which is not a secret.
    if (access && !canRead(caller, access->owner, access->visibility))
      return error(drogon::k404NotFound, "no such tree");
    // Two refusals, because there are two truths. Naming an unowned tree as somebody else's is a
    // lie a reader can act on — they go looking for the account that took it, and there is none.
    if (access && !canWrite(caller, access->owner))
      return error(drogon::k403Forbidden, access->owner
                                              ? "this tree belongs to another account"
                                              : "no account owns this tree, so it cannot be edited");

    // Authorized — so now flush and close any live room, and read the row that flush just wrote.
    // Reading it any earlier would take a row the room has already run past, and lose twice over:
    // head_seq rewinds under the op log, whose tail then replays straight back over this PUT, and
    // the title mints past a stamp the room has already moved beyond, so a rename made over the
    // socket silently outlives the document this PUT answered 200 for.
    registry_->evict(TreeId{treeId});
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});

    // The legend is part of the document: honour a posted one; otherwise seed the three
    // defaults for a brand-new tree, or keep the existing legend on an overwrite.
    LegendState legend;
    if (!data.kinds.empty()) legend = Legend(data.kinds, genesis_).exportState();
    else if (existing) legend = existing->legend;
    else legend = Legend::seededDefaults(genesis_).exportState();

    if (!existing) {
      // Born owned, in one insert. There is no instant at which this row exists without an
      // owner, so no window in which another account could reach it — the create-then-claim
      // pair this replaced left exactly that window open on every PUT.
      try {
        trees_->create(TreeId{treeId}, state, legend, data.title, *caller);
      } catch (const DuplicateTree&) {
        // Lost an insert race, or the id names a soft-deleted row that still holds it (the
        // standalone MCP binary shares this DB). Either way the id is taken, and not by this PUT.
        return error(drogon::k409Conflict, "a tree with that id already exists");
      }
    } else {
      // The posted document is the new baseline, title included, minted past the stored
      // register so it clears the repository's LWW guard — an overwrite means what it says.
      HlcClock mint{std::string{TreeRoom::kServerActor}};
      mint.observe(existing->title.stamp);
      trees_->save(TreeId{treeId}, state, legend, Lww<std::string>{data.title, mint.tick(0)},
                   existing->head);
    }

    data.kinds = Legend(legend).kinds();  // reflect the authoritative legend back to the client
    Json::Value body(Json::objectValue);
    body["seq"] = static_cast<Json::Int64>(existing ? existing->head : 0);
    body["data"] = toJson(data);
    return jsonResponse(body);
  }();
  callback(reply);
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
      TreeRoom* room = registry_->open(TreeId{treeId});
      if (!room || !canRead(caller, room->owner(), room->visibility())) found = false;
      else owner = room->owner();
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
      TreeRoom* room = registry_->open(TreeId{treeId});
      if (!room || !canRead(caller, room->owner(), room->visibility())) found = false;  // absent or gated
      else current = room->snapshot();
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
