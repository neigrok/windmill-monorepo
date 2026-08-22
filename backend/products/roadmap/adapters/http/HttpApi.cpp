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

// Every room-backed read opens its tree the same way, and refuses in the same breath: an absent
// tree (a null open), a private one this caller may not read, and an infrastructure failure all
// answer false, so all three become the one 404 the callers give. That is what the arms are for —
// a body byte-identical to absent means an id cannot be probed for existence, and a thrown pqxx
// message (a host, a role, a connection string) never rides out to the client. `read` runs under
// the strand, so a caller's own work is bracketed by the same lock the open needed.
bool HttpApi::readRoom(const std::string& treeId, const std::optional<UserId>& caller,
                       const std::function<void(TreeRoom&)>& read) {
  std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{treeId}));
  try {
    TreeRoom* room = registry_->open(TreeId{treeId});
    if (!room || !canRead(caller, room->owner(), room->visibility())) return false;
    read(*room);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

void HttpApi::getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  Json::Value body(Json::objectValue);
  if (!readRoom(treeId, caller, [&](TreeRoom& room) {
        body["seq"] = static_cast<Json::Int64>(room.head());
        body["data"] = toJson(room.snapshot());  // projected TreeData for the first paint
        Subgraph state;  // the stamped lattice the client builds its TreeLattice from
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
        // The share flip reads these: the current visibility, and whether this tree is the
        // caller's to change — which is canWrite exactly, so the client's "mine" and the
        // server's write gate can never drift apart into a button that refuses itself.
        body["visibility"] = toString(room.visibility());
        body["mine"] = canWrite(caller, room.owner());
      })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  callback(jsonResponse(body));
}

void HttpApi::getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  Json::Value body;
  if (!readRoom(treeId, callerOf(req), [&](TreeRoom& room) { body = toJson(room.diagnose()); })) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  callback(jsonResponse(body));
}

void HttpApi::putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId) {
  std::optional<UserId> caller = callerOf(req);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to edit"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // A root that parsed but is not an object — `[]`, `"hello"`, `5` — is refused HERE, before any
  // reader indexes it: jsoncpp throws on a keyed read of an array or a scalar, and that throw
  // escaped the handler as a 500, a server_errors row and a Sentry event per request.
  if (!json || !json->isObject()) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  std::optional<TreeData> data = treeFromJson(*json, TreeId{treeId});
  if (!data) {
    callback(error(drogon::k400BadRequest, "invalid json body"));
    return;
  }
  // What the posted document can be judged on before the tree it lands on is even loaded: the
  // title, the legend, every per-node field, and the caps for the tree this document would be on
  // its own. What it would leave BEHIND is judged under the strand below, against the graph.
  if (std::optional<Admission> refusal = admit(*data)) {
    const bool tooLarge = refusal->verdict == Admission::Verdict::tooLarge;
    callback(error(tooLarge ? drogon::k413RequestEntityTooLarge : drogon::k400BadRequest, refusal->reason));
    return;
  }
  GraphState state = LooseGraph(*data, genesis_).exportState();  // seed full state from the posted tree

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
    // Two refusals, because there are two truths (Access.h): naming an unowned tree as somebody
    // else's is a lie a reader can act on — they go looking for the account that took it, and
    // there is none. The code rides beside the sentence so a client branches without reading it.
    if (access) {
      if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, access->owner))
        return error(drogon::k403Forbidden, sentenceOf(*refusal), codeOf(*refusal));
    }

    // A PUT to an id no row holds CREATES the tree, so it mints an id exactly as fork and create
    // do and must obey the same shape. An EXISTING tree keeps whatever id it has: slug ids like
    // `windmill-roadmap` predate the mint and are the documented contract (db/schema.sql), so
    // gating them here would have locked their owners out of their own roadmaps.
    if (!access && !wellFormedTreeId(treeId))
      return error(drogon::k400BadRequest, "id must be t_ followed by 16 lowercase hex characters", "bad-id");

    // Authorized — so now flush and close any live room, and read the row that flush just wrote.
    // Reading it any earlier would take a row the room has already run past, and lose twice over:
    // head_seq rewinds under the op log, whose tail then replays straight back over this PUT, and
    // the title mints past a stamp the room has already moved beyond, so a rename made over the
    // socket silently outlives the document this PUT answered 200 for.
    registry_->evict(TreeId{treeId});
    std::optional<StoredTree> existing = trees_->load(TreeId{treeId});

    // A save GROWS the stored lattice — it upserts the entries the document names and deletes
    // nothing — so the ceiling has to be read off what the tree would HOLD, not off this one
    // request's payload. Judged on the document alone, five individually-legal PUTs of 10000
    // fresh ids each left 45000 nodes standing on a 10000 cap.
    if (existing) {
      if (std::optional<Admission> refusal = admit(LooseGraph(existing->state), *data)) {
        const bool tooLarge = refusal->verdict == Admission::Verdict::tooLarge;
        return error(tooLarge ? drogon::k413RequestEntityTooLarge : drogon::k400BadRequest, refusal->reason);
      }
    }

    // The legend is part of the document: honour a posted one; otherwise seed the three
    // defaults for a brand-new tree, or keep the existing legend on an overwrite.
    LegendState legend;
    if (!data->kinds.empty()) legend = Legend(data->kinds, genesis_).exportState();
    else if (existing) legend = existing->legend;
    else legend = Legend::seededDefaults(genesis_).exportState();

    if (!existing) {
      // Born owned, in one insert. There is no instant at which this row exists without an
      // owner, so no window in which another account could reach it — the create-then-claim
      // pair this replaced left exactly that window open on every PUT.
      try {
        trees_->create(TreeId{treeId}, state, legend, data->title, *caller);
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
      trees_->save(TreeId{treeId}, state, legend, Lww<std::string>{data->title, mint.tick(0)},
                   existing->head);
    }

    data->kinds = Legend(legend).kinds();  // reflect the authoritative legend back to the client
    Json::Value body(Json::objectValue);
    body["seq"] = static_cast<Json::Int64>(existing ? existing->head : 0);
    body["data"] = toJson(*data);
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
  // A non-object root is refused before it is indexed — see putTree: a keyed read of an array
  // throws out of the handler and lands as a 500 with a server_errors row.
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
  if (!readRoom(treeId, caller, [&](TreeRoom& room) { owner = room.owner(); })) {
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
