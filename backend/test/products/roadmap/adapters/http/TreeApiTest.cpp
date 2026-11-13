#include "products/roadmap/adapters/http/TreeApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include "platform/application/WriteObservation.h"
#include "platform/ports/FailureReporter.h"

#include <algorithm>
#include <chrono>
#include <optional>
#include <set>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <typeinfo>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct Harness {
  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>(*progress);
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus);
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, *clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<ForkService> fork = std::make_shared<ForkService>(*rooms, *trees, tokens, *clock);
  std::shared_ptr<OwnerProgress> ownerProgress = std::make_shared<OwnerProgress>(*progress, *trees, *clock);
  TreeApi api{rooms, trees, ownerProgress, ops, Hlc{1, 0, "genesis"}, auth, fork, clock};

  UserId signIn(const std::string& sessionSecret, const std::string& email = "sam@example.com") {
    User user = authRepo.createUser(Email{email}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "", clock->now);
    return user.id;
  }

  // A tree of the steps named, each opening the tree given beside it, or none for "".
  void seedSteps(const char* id, const UserId& owner, Visibility visibility,
                 const std::vector<std::pair<const char*, const char*>>& steps) {
    LooseGraph graph;
    for (const auto& [step, opens] : steps) {
      graph.createNode(NodeId{step}, step, "", NodeColor::sky, Hlc{1, 0, "seed"});
      if (std::string(opens) != "") graph.setOpens(NodeId{step}, TreeId{opens}, Hlc{2, 0, "seed"});
    }
    trees->byId[id] = StoredTree{graph.exportState(), LegendState{}, {id, {}}, 0, owner, visibility};
  }

  // The contract's wire example (SPEC.md, Model, Subtrees): roots `t_a` "My year" and `t_b` "Work"; in `t_a`, `sail`
  // owns `t_s` and `coast` needs `sail`; in `t_s`, `rig` owns `t_r` beside `knot`; `t_r` holds `bowline`.
  void seedForest(const UserId& owner, Visibility visibility) {
    const auto planted = [&](const char* id, const char* title, const std::vector<std::pair<const char*, const char*>>& steps) {
      LooseGraph graph;
      std::uint64_t ms = 1;
      for (const auto& [step, label] : steps) graph.createNode(NodeId{step}, label, "", NodeColor::sky, Hlc{ms++, 0, "seed"});
      if (std::string(id) == "t_a") graph.addEdge(NodeId{"sail"}, NodeId{"coast"}, Hlc{ms, 0, "seed"});
      trees->byId[id] = StoredTree{graph.exportState(), LegendState{}, {title, {}}, 0, owner, visibility};
    };
    planted("t_a", "My year", {{"sail", "Learn to sail"}, {"coast", "Sail the coast"}});
    planted("t_b", "Work", {{"ship", "Ship it"}});
    planted("t_s", "", {{"rig", "Rig the boat"}, {"knot", "Tie a knot"}});
    planted("t_r", "", {{"bowline", "Bowline"}});
    trees->subtrees["t_s"] = Subtree{TreeId{"t_s"}, TreeId{"t_a"}, OwningStep{TreeId{"t_a"}, NodeId{"sail"}}, 1, 0};
    trees->subtrees["t_r"] = Subtree{TreeId{"t_r"}, TreeId{"t_a"}, OwningStep{TreeId{"t_s"}, NodeId{"rig"}}, 2, 0};
  }

  void mark(const char* tree, const UserId& owner, const char* step, ProgressStatus status, std::uint64_t ms) {
    progress->setStatuses(TreeId{tree}, owner, {{NodeId{step}, status, false, Hlc{ms, 0, "r_a"}}}, StampedBy::replica, ms);
  }

  void seedSource(const char* id, const char* title) {
    seed(id, title, UserId{"owner"}, Visibility::unlisted);
  }
  void seed(const char* id, const char* title, const UserId& owner, Visibility visibility) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    data.title = title;
    NodeSpec root;
    root.id = NodeId{"root"};
    root.label = "Root";
    data.nodes = {root};
    GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
    trees->byId[id] = StoredTree{state, LegendState{}, {title, {}}, 0, owner, visibility};
  }
};

drogon::HttpRequestPtr getRequest(const std::string& session) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendGetTree(TreeApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getTree(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetGuides(TreeApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getGuides(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetDiagnostics(TreeApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getDiagnostics(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetActivity(TreeApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getActivity(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGetProgress(TreeApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getProgress(getRequest(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

Json::Value document(const std::string& title, const std::string& nodeId) {
  Json::Value node(Json::objectValue);
  node["id"] = nodeId;
  node["label"] = nodeId;
  Json::Value body(Json::objectValue);
  body["title"] = title;
  body["nodes"] = Json::Value(Json::arrayValue);
  body["nodes"].append(node);
  return body;
}

drogon::HttpResponsePtr sendPutText(TreeApi& api, const std::string& session, const std::string& id,
                                    const std::string& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Put);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(body);
  if (!session.empty()) request->addCookie("wm_session", session);
  drogon::HttpResponsePtr captured;
  api.putTree(request, [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendPut(TreeApi& api, const std::string& session, const std::string& id,
                                const Json::Value& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Put);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  drogon::HttpResponsePtr captured;
  api.putTree(request, [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

void editInTheLiveRoom(Harness& h, const char* id, const char* nodeId, const UserId& actor) {
  std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{id}));
  h.rooms->open(TreeId{id})->applyCommand(createNode(nodeId), 5'000, actor);
}

std::vector<std::string> storedNodeIds(FakeTreeRepository& trees, const std::string& id) {
  std::vector<std::string> out;
  for (const NodeId& node : LooseGraph(trees.byId[id].state).presentNodeIds()) out.push_back(node.str());
  return out;
}

drogon::HttpRequestPtr forkRequest(const Json::Value& body, const std::string& session) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

drogon::HttpResponsePtr sendFork(TreeApi& api, const drogon::HttpRequestPtr& request,
                                 const std::string& source) {
  drogon::HttpResponsePtr captured;
  api.forkTree(request, [&](const drogon::HttpResponsePtr& response) { captured = response; }, source);
  return captured;
}

Json::Value withId(const std::string& id) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  return body;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

// The single completed id in a progress body, or "" for none; the body is a lattice frame of stamped registers.
std::string soleCompleted(const drogon::HttpResponsePtr& response) {
  // Bind the body to a named local: a range-for over bodyOf(response)["marks"] walks a destroyed temporary.
  const Json::Value body = bodyOf(response);
  std::string found;
  for (const Json::Value& mark : body["marks"]) {
    if (mark["status"].asString() != "complete") continue;
    if (!found.empty()) return "";  // more than one: the callers all seed exactly one
    found = mark["node"].asString();
  }
  return found;
}

}

TEST(fork_rejects_a_malformed_requested_id_before_touching_the_source) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  const std::string malformed[] = {
      "t_0123456789ABCDEF",   // uppercase hex
      "x_0123456789abcdef",   // wrong prefix
      "t_0123456789abcde",    // 15 hex chars
      "t_0123456789abcdef0",  // 17 hex chars
      "t_' OR '1'='1;--xx",   // injection junk, length-correct
  };
  for (const std::string& id : malformed) {
    drogon::HttpResponsePtr response = sendFork(h.api, forkRequest(withId(id), "s-live"), "t_src");
    CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(response)),
             std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  }
  CHECK_EQ(h.trees->byId.size(), 1u);
  CHECK(h.trees->forkedFrom.empty());
}

TEST(fork_accepts_a_well_formed_requested_id) {
  Harness h;
  UserId me = h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  drogon::HttpResponsePtr response =
      sendFork(h.api, forkRequest(withId("t_0123456789abcdef"), "s-live"), "t_src");

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["seq"].asInt64(), 0);
  CHECK_EQ(body["data"]["id"].asString(), std::string("t_0123456789abcdef"));
  CHECK_EQ(h.trees->forkedFrom["t_0123456789abcdef"], std::string("t_src"));
  CHECK(h.trees->byId["t_0123456789abcdef"].owner == std::optional<UserId>(me));
}

TEST(fork_answers_with_the_guide_it_copied) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");
  h.trees->byId["t_src"].guide = Lww<std::string>{"Rig first, then sail.", Hlc{5, 0, "srv"}};

  drogon::HttpResponsePtr response =
      sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-live"), "t_src");

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(bodyOf(response)["data"]["guide"].asString(), std::string("Rig first, then sail."));
  CHECK(h.trees->byId["t_d1"].guide == (Lww<std::string>{"Rig first, then sail.", Hlc{h.clock->nowMs(), 0, "srv"}}));
}

TEST(fork_without_an_id_still_mints_one) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");

  drogon::HttpResponsePtr response =
      sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-live"), "t_src");

  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(bodyOf(response)["data"]["id"].asString(), std::string("t_d1"));
  CHECK_EQ(h.trees->forkedFrom["t_d1"], std::string("t_src"));
}

// A source saved while nodes still stored a position forks exactly as its twin that never had one.
TEST(fork_of_a_source_that_stored_a_position_carries_none) {
  Harness h;
  h.signIn("s-live");
  const char* plain =
      R"({"nodes":[{"id":"root","createdAt":"1:0:seed","label":"Root","labelAt":"1:0:seed"}],"edges":[]})";
  const char* placed = R"({"nodes":[{"id":"root","createdAt":"1:0:seed","label":"Root","labelAt":"1:0:seed",
                                     "position":{"x":3,"y":4},"positionAt":"2:0:seed"}],"edges":[]})";
  h.trees->byId["t_placed"] = StoredTree{graphStateFromJson(parse(placed)), LegendState{}, {"Sail", {}}, 0,
                                         UserId{"owner"}, Visibility::unlisted};
  h.trees->byId["t_plain"] = StoredTree{graphStateFromJson(parse(plain)), LegendState{}, {"Sail", {}}, 0,
                                        UserId{"owner"}, Visibility::unlisted};

  Json::Value fromPlaced =
      bodyOf(sendFork(h.api, forkRequest(withId("t_00000000000000a1"), "s-live"), "t_placed"));
  Json::Value fromPlain = bodyOf(sendFork(h.api, forkRequest(withId("t_00000000000000a2"), "s-live"), "t_plain"));

  fromPlaced["data"].removeMember("id");
  fromPlain["data"].removeMember("id");
  CHECK_EQ(fromPlaced, fromPlain);
  CHECK_EQ(dump(toJson(h.trees->byId["t_00000000000000a1"].state)),
           dump(toJson(h.trees->byId["t_00000000000000a2"].state)));
}

// ---- read enforcement (tree-visibility) --------------------------------------------------

TEST(get_tree_owner_reads_a_private_tree_with_mine_true) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", "My private plan", me, Visibility::private_);

  drogon::HttpResponsePtr response = sendGetTree(h.api, "s-me", "t_priv");

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["visibility"].asString(), std::string("private"));
  CHECK(body["mine"].asBool());
  CHECK(body.isMember("data"));
  CHECK(body.isMember("state"));
  CHECK_EQ(body["seq"].asInt64(), 0);
}

TEST(get_tree_carries_the_guide_beside_the_title_to_any_reader_and_an_empty_one_when_there_is_none) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_guided", "Learn to sail", me, Visibility::unlisted);
  h.seed("t_plain", "Sourdough", me, Visibility::unlisted);
  h.trees->byId["t_guided"].guide = Lww<std::string>{"Rig first, then sail.", Hlc{5, 0, "srv"}};

  Json::Value guided = bodyOf(sendGetTree(h.api, "", "t_guided"));
  Json::Value plain = bodyOf(sendGetTree(h.api, "s-me", "t_plain"));

  CHECK_EQ(guided["data"]["title"].asString(), std::string("Learn to sail"));
  CHECK_EQ(guided["data"]["guide"].asString(), std::string("Rig first, then sail."));
  CHECK(plain["data"]["guide"].isString());
  CHECK_EQ(plain["data"]["guide"].asString(), std::string(""));
}

TEST(get_tree_serves_the_planting_time_and_zero_when_there_is_none) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_plant", "Sourdough", me, Visibility::private_);
  h.seed("t_undated", "Ancient", me, Visibility::private_);
  h.trees->byId["t_plant"].createdAt = 1'753'400'000'000;  // epoch ms

  Json::Value planted = bodyOf(sendGetTree(h.api, "s-me", "t_plant"));
  Json::Value undated = bodyOf(sendGetTree(h.api, "s-me", "t_undated"));

  CHECK_EQ(planted["createdAt"].asInt64(), 1'753'400'000'000);
  CHECK(undated.isMember("createdAt"));  // present and 0 — never missing, never null
  CHECK_EQ(undated["createdAt"].asInt64(), 0);
}

TEST(get_tree_gives_the_tree_a_node_opens_to_its_owner_and_to_no_other_reader) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_pub", "Public", owner, Visibility::public_);
  NodeStateEntry withheld = h.trees->byId["t_pub"].state.nodes[0];
  NodeStateEntry whole = withheld;
  whole.opens = TreeId{"t_00000000000000f2"};  // the owner's unlisted tree: its id is its key
  whole.opensAt = Hlc{2000, 0, "r_a"};
  {
    std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{"t_pub"}));
    Subgraph pointed;
    pointed.frameId = "f-open";
    pointed.graph.nodes.emplace_back();
    pointed.graph.nodes[0].id = whole.id;
    pointed.graph.nodes[0].opens = whole.opens;
    pointed.graph.nodes[0].opensAt = whole.opensAt;
    h.rooms->open(TreeId{"t_pub"})->joinSubgraph(pointed, owner);
  }
  NodeSpec document;
  document.id = whole.id;
  document.label = "Root";

  for (const char* reader : {"s-stranger", ""}) {
    const Json::Value read = bodyOf(sendGetTree(h.api, reader, "t_pub"));
    CHECK_FALSE(read["mine"].asBool());
    CHECK_EQ(read["data"]["nodes"].size(), 1u);
    CHECK_EQ(read["data"]["nodes"][0], nodeToJson(document));
    CHECK_FALSE(read["data"]["nodes"][0].isMember("opens"));
    CHECK_EQ(read["state"]["nodes"], toJson(GraphState{{withheld}, {}})["nodes"]);
    CHECK_EQ(read["state"]["nodes"][0]["opens"].asString(), std::string(""));
    CHECK_EQ(read["state"]["nodes"][0]["opensAt"].asString(), std::string("0:0:"));
  }

  const Json::Value mine = bodyOf(sendGetTree(h.api, "s-owner", "t_pub"));
  CHECK(mine["mine"].asBool());
  document.opens = whole.opens;
  CHECK_EQ(mine["data"]["nodes"].size(), 1u);
  CHECK_EQ(mine["data"]["nodes"][0], nodeToJson(document));
  CHECK_EQ(mine["state"]["nodes"], toJson(GraphState{{whole}, {}})["nodes"]);
  CHECK_EQ(mine["state"]["nodes"][0]["opens"].asString(), std::string("t_00000000000000f2"));
  CHECK_EQ(mine["state"]["nodes"][0]["opensAt"].asString(), std::string("2000:0:r_a"));
}

TEST(get_tree_answers_the_owner_what_each_pointer_comes_to_and_no_other_reader_the_key) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  const UserId stranger = h.signIn("s-stranger", "stranger@example.com");
  const auto plant = [&](const char* id, const char* title, const UserId& planter, std::vector<std::pair<const char*, const char*>> nodes) {
    TreeData data;
    data.id = TreeId{id};
    data.title = title;
    for (const auto& [node, opens] : nodes) {
      NodeSpec spec;
      spec.id = NodeId{node};
      spec.label = node;
      spec.opens = TreeId{opens};
      data.nodes.push_back(spec);
    }
    h.trees->byId[id] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {title, {}}, 0, planter,
                                   Visibility::public_};
  };
  const auto mark = [&](const char* tree, const UserId& user, const char* node) {
    h.progress->setStatuses(TreeId{tree}, user, {{NodeId{node}, ProgressStatus::complete, false, Hlc{2, 0, "seed"}}}, StampedBy::replica, 0);
  };
  plant("t_main", "Main", owner, {{"done-idea", "t_done"}, {"open-idea", "t_open"}, {"round", "t_round"}, {"self", "t_main"},
                                  {"gone", "t_gone"}, {"theirs", "t_theirs"}, {"plain", ""}});
  plant("t_done", "Done", owner, {{"d", ""}});
  plant("t_open", "Open", owner, {{"o1", ""}, {"o2", ""}});
  plant("t_round", "Round", owner, {{"back", "t_main"}});
  plant("t_gone", "Gone", owner, {{"g", ""}});
  plant("t_theirs", "Theirs", stranger, {{"x", ""}});
  plant("t_plain", "Plain", owner, {{"p", ""}});
  h.trees->softDelete(TreeId{"t_gone"});
  mark("t_done", owner, "d");
  mark("t_open", owner, "o1");
  mark("t_open", stranger, "o2");
  mark("t_main", owner, "open-idea");
  mark("t_main", stranger, "done-idea");

  const Json::Value mine = bodyOf(sendGetTree(h.api, "s-owner", "t_main"));
  CHECK_EQ(mine["opens"], parse(R"({
      "done-idea": {"treeId":"t_done","title":"Done","state":"complete","done":1,"total":1,"loop":false},
      "open-idea": {"treeId":"t_open","title":"Open","state":"open","done":1,"total":2,"loop":false},
      "round": {"treeId":"t_round","title":"Round","state":"open","done":0,"total":1,"loop":true},
      "self": {"treeId":"t_main","title":"Main","state":"open","done":1,"total":7,"loop":true},
      "gone": {"treeId":"t_gone","missing":true},
      "theirs": {"treeId":"t_theirs","missing":true}})"));
  CHECK_EQ(h.trees->openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_done"}, TreeId{"t_gone"}, TreeId{"t_main"},
                                                                 TreeId{"t_open"}, TreeId{"t_round"}, TreeId{"t_theirs"}}}));
  CHECK_EQ(bodyOf(sendGetTree(h.api, "s-owner", "t_plain"))["opens"], parse("{}"));
  CHECK_EQ(h.trees->openedReads.size(), 1u);

  h.trees->openedReadsFail = true;
  for (const char* reader : {"s-stranger", ""}) {
    const Json::Value read = bodyOf(sendGetTree(h.api, reader, "t_main"));
    CHECK_EQ(read.getMemberNames(), (std::vector<std::string>{"createdAt", "data", "depth", "mine", "parent", "path", "root", "seq", "state", "visibility"}));
    CHECK_EQ(dump(read).find("t_done"), std::string::npos);
    CHECK_EQ(dump(read).find("opens\":\"t_"), std::string::npos);
  }
  CHECK_EQ(h.trees->openedReads.size(), 1u);
}

// A failed follow is not an absent tree: the owner is answered a 503 the client reports, under the follow's own name.
TEST(get_tree_whose_pointers_cannot_be_followed_answers_503_and_files_one_issue_and_other_reads_still_answer) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_sub", "Deep dive", me, Visibility::private_);
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].state.nodes[0].opens = TreeId{"t_sub"};
  h.trees->byId["t_mine"].state.nodes[0].opensAt = Hlc{2, 0, "seed"};

  h.trees->openedReadsFail = true;
  const drogon::HttpResponsePtr failed = sendGetTree(h.api, "s-me", "t_mine");

  REQUIRE_EQ(failed->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bodyOf(failed),
           parse(R"({"code":"opens-unavailable","error":"the trees this tree opens could not be read — try again"})"));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.tree.follow roadmap rest failed ") + typeid(std::runtime_error).name()}));
  CHECK_EQ(sendGetTree(h.api, "", "t_mine")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendGetTree(h.api, "s-me", "t_sub")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(reporter.failures->reports.size(), 1u);
}

// A stranger's read must not wait on the owner's statement: that wait would say the tree holds a pointer.
TEST(get_tree_follows_pointers_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_sub", "Deep dive", me, Visibility::private_);
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].state.nodes[0].opens = TreeId{"t_sub"};
  h.trees->byId["t_mine"].state.nodes[0].opensAt = Hlc{2, 0, "seed"};
  bool strandWasFree = false;
  drogon::HttpStatusCode readMeanwhile = drogon::kUnknown;
  h.trees->duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.rooms->strandFor(TreeId{"t_mine"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = sendGetTree(h.api, "", "t_mine")->getStatusCode();
    });
    other.join();
  };

  CHECK_EQ(sendGetTree(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);

  CHECK_EQ(h.trees->openedReads.size(), 1u);
  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, drogon::k200OK);
}

// Guides add: the owner is answered the guides of their own trees above, farthest first, and the tree's own last; every
// other reader the tree's own alone, with nothing read for them.
TEST(get_guides_answers_the_guides_above_to_the_owner_and_the_trees_own_guide_alone_to_every_other_reader) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  const auto plant = [&](const char* id, const char* title, const char* guide, const char* opens) {
    TreeData data;
    data.id = TreeId{id};
    NodeSpec pointer;
    pointer.id = NodeId{"pointer"};
    pointer.label = "Pointer";
    pointer.opens = TreeId{opens};
    data.nodes = {pointer};
    StoredTree stored{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {title, {}}, 0, owner, Visibility::private_};
    stored.guide = Lww<std::string>{guide, Hlc{2, 0, "seed"}};
    h.trees->byId[id] = stored;
  };
  h.seed("t_leaf", "Leaf", owner, Visibility::public_);
  h.trees->byId["t_leaf"].guide = Lww<std::string>{"Tests before code.", Hlc{2, 0, "seed"}};
  plant("t_middle", "Middle", "Ship weekly.", "t_leaf");
  plant("t_root", "Root", "Write the outcome first.", "t_middle");
  plant("t_silent", "Silent", "", "t_leaf");
  plant("t_gone", "Gone", "Removed.", "t_leaf");
  h.trees->softDelete(TreeId{"t_gone"});
  Json::Value pointing = document("Theirs", "pointer");
  pointing["nodes"][0]["opens"] = "t_leaf";
  REQUIRE_EQ(sendPut(h.api, "s-stranger", "t_00000000000000a1", pointing)->getStatusCode(), drogon::k200OK);
  REQUIRE_EQ(h.trees->byId["t_00000000000000a1"].state.nodes.size(), 1u);
  CHECK_EQ(h.trees->byId["t_00000000000000a1"].state.nodes[0].opens, TreeId{"t_leaf"});
  h.trees->byId["t_00000000000000a1"].guide = Lww<std::string>{"The stranger's own method.", Hlc{2, 0, "seed"}};

  for (const char* reader : {"s-stranger", ""})
    CHECK_EQ(bodyOf(sendGetGuides(h.api, reader, "t_leaf")),
             parse(R"({"guides":[{"treeId":"t_leaf","title":"Leaf","text":"Tests before code.","yours":false}]})"));
  CHECK(h.trees->aboveReads.empty());

  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-owner", "t_leaf")),
           parse(R"({"guides":[{"treeId":"t_root","title":"Root","text":"Write the outcome first.","yours":true},
                               {"treeId":"t_middle","title":"Middle","text":"Ship weekly.","yours":true},
                               {"treeId":"t_leaf","title":"Leaf","text":"Tests before code.","yours":true}]})"));
  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-owner", "t_root")),
           parse(R"({"guides":[{"treeId":"t_root","title":"Root","text":"Write the outcome first.","yours":true}]})"));
  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-owner", "t_silent")), parse(R"({"guides":[]})"));
  CHECK_EQ(h.trees->aboveReads, (std::vector<TreeId>{TreeId{"t_leaf"}, TreeId{"t_root"}, TreeId{"t_silent"}}));
}

// The route answers an absent tree and one the caller may not read as the tree route does, in the same bytes, and reads nothing.
TEST(get_guides_of_an_absent_tree_and_of_a_private_tree_the_caller_cannot_read_is_the_tree_routes_404) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);
  h.trees->byId["t_priv"].guide = Lww<std::string>{"A private method.", Hlc{2, 0, "seed"}};

  for (const auto& [reader, tree] : std::vector<std::pair<const char*, const char*>>{{"", "t_priv"}, {"s-other", "t_priv"},
                                                                                 {"s-other", "t_ghost"}}) {
    const drogon::HttpResponsePtr refused = sendGetGuides(h.api, reader, tree);
    CHECK_EQ(refused->getStatusCode(), drogon::k404NotFound);
    CHECK_EQ(dump(bodyOf(refused)), dump(bodyOf(sendGetTree(h.api, reader, tree))));
    CHECK_EQ(dump(bodyOf(refused)), std::string(R"({"error":"no such tree"})"));
  }
  CHECK(h.trees->aboveReads.empty());
}

// The tree load carries no guides and makes no walk, so a walk that cannot be made never fails it.
TEST(get_tree_carries_no_guides_and_never_reads_the_trees_above) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].guide = Lww<std::string>{"Rig first, then sail.", Hlc{2, 0, "seed"}};
  h.trees->aboveReadsFail = true;

  const drogon::HttpResponsePtr mine = sendGetTree(h.api, "s-me", "t_mine");
  CHECK_EQ(mine->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(mine).getMemberNames(),
           (std::vector<std::string>{"createdAt", "data", "depth", "mine", "opens", "parent", "path", "root", "seq", "state",
                                     "visibility"}));
  CHECK_EQ(bodyOf(sendGetTree(h.api, "", "t_mine")).getMemberNames(),
           (std::vector<std::string>{"createdAt", "data", "depth", "mine", "parent", "path", "root", "seq", "state", "visibility"}));
  CHECK(h.trees->aboveReads.empty());
}

TEST(get_guides_says_a_guide_a_fork_copied_is_not_the_owners_own_and_one_they_wrote_is) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_copy", "Forked plan", me, Visibility::private_);
  h.trees->byId["t_copy"].guide = Lww<std::string>{"Its author's method.", Hlc{2, 0, "seed"}};
  h.trees->byId["t_copy"].guideInherited = true;
  h.seed("t_mine", "My plan", me, Visibility::private_);
  h.trees->byId["t_mine"].guide = Lww<std::string>{"My method.", Hlc{2, 0, "seed"}};

  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-me", "t_copy")),
           parse(R"({"guides":[{"treeId":"t_copy","title":"Forked plan","text":"Its author's method.","yours":false}]})"));
  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-me", "t_mine")),
           parse(R"({"guides":[{"treeId":"t_mine","title":"My plan","text":"My method.","yours":true}]})"));
}

// A failed walk is not an absent tree: the owner is answered a 503 the client reports, under the walk's own name,
// and the tree itself still loads.
TEST(get_guides_whose_trees_above_cannot_be_read_answers_503_and_files_one_issue_and_the_tree_and_other_readers_still_answer) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].guide = Lww<std::string>{"Rig first, then sail.", Hlc{2, 0, "seed"}};

  h.trees->aboveReadsFail = true;
  const drogon::HttpResponsePtr failed = sendGetGuides(h.api, "s-me", "t_mine");

  REQUIRE_EQ(failed->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bodyOf(failed),
           parse(R"({"code":"guides-unavailable","error":"the guides of the trees above this one could not be read — try again"})"));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.tree.guides roadmap rest failed ") + typeid(std::runtime_error).name()}));
  const drogon::HttpResponsePtr signedOut = sendGetGuides(h.api, "", "t_mine");
  CHECK_EQ(signedOut->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(signedOut),
           parse(R"({"guides":[{"treeId":"t_mine","title":"Learn to sail","text":"Rig first, then sail.","yours":false}]})"));
  CHECK_EQ(sendGetTree(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(reporter.failures->reports.size(), 1u);
}

// A stranger's read must not wait on the owner's statement: that wait would say a tree of the owner's opens this one.
TEST(get_guides_reads_the_trees_above_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  bool strandWasFree = false;
  drogon::HttpStatusCode readMeanwhile = drogon::kUnknown;
  h.trees->duringAboveRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.rooms->strandFor(TreeId{"t_mine"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = sendGetGuides(h.api, "", "t_mine")->getStatusCode();
    });
    other.join();
  };

  CHECK_EQ(sendGetGuides(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);

  CHECK_EQ(h.trees->aboveReads, (std::vector<TreeId>{TreeId{"t_mine"}}));
  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, drogon::k200OK);
}

TEST(get_tree_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendGetTree(h.api, "s-other", "t_priv");
  drogon::HttpResponsePtr absent = sendGetTree(h.api, "s-other", "t_ghost");

  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(nonOwner->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  const std::string absentBody = dump(bodyOf(absent));
  CHECK_EQ(dump(bodyOf(anon)), absentBody);
  CHECK_EQ(dump(bodyOf(nonOwner)), absentBody);
  CHECK_EQ(absentBody, std::string(R"({"error":"no such tree"})"));
}

TEST(get_tree_unlisted_is_readable_by_anyone_but_not_mine_for_a_stranger) {
  Harness h;
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::unlisted);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_shared");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(anon);
  CHECK_EQ(body["visibility"].asString(), std::string("unlisted"));
  CHECK_FALSE(body["mine"].asBool());
}

TEST(get_tree_public_is_world_readable) {
  Harness h;
  h.seed("t_demo", "The demo", UserId{"owner"}, Visibility::public_);

  drogon::HttpResponsePtr anon = sendGetTree(h.api, "", "t_demo");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(anon)["visibility"].asString(), std::string("public"));
}

TEST(get_diagnostics_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "Mine", me, Visibility::private_);
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  CHECK_EQ(sendGetDiagnostics(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr anon = sendGetDiagnostics(h.api, "", "t_priv");
  drogon::HttpResponsePtr absent = sendGetDiagnostics(h.api, "", "t_ghost");
  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(anon)), dump(bodyOf(absent)));
}

TEST(get_diagnostics_unlisted_is_readable_by_anyone) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted);
  CHECK_EQ(sendGetDiagnostics(h.api, "", "t_shared")->getStatusCode(), drogon::k200OK);
}

// Only the tree's writer is told what is wrong with its pointers: every loop of trees through the tree with a
// shortest way back, and every pointer that names no standing tree of theirs. A reader of the same tree is answered,
// byte for byte, what a twin without pointers answers, and nothing is read for them.
TEST(get_diagnostics_tells_the_owner_its_loops_of_trees_and_dangling_pointers_and_a_reader_what_a_twin_without_pointers_answers) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  const UserId stranger = h.signIn("s-stranger", "stranger@example.com");
  const auto plant = [&](const char* id, const char* title, const UserId& planter, std::vector<std::pair<const char*, const char*>> nodes) {
    TreeData data;
    data.id = TreeId{id};
    data.title = title;
    for (const auto& [node, opens] : nodes) {
      NodeSpec spec;
      spec.id = NodeId{node};
      spec.label = node;
      spec.icon = "i";
      spec.opens = TreeId{opens};
      data.nodes.push_back(spec);
    }
    h.trees->byId[id] = StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {title, {}}, 0, planter,
                                   Visibility::public_};
  };
  plant("t_main", "Main", owner, {{"round", "t_far"}, {"near", "t_near"}, {"self", "t_main"}, {"elsewhere", "t_x"},
                                  {"gone", "t_gone"}, {"theirs", "t_theirs"}, {"text", "said \"so\""}, {"plain", ""}});
  plant("t_twin", "Main", owner, {{"round", ""}, {"near", ""}, {"self", ""}, {"elsewhere", ""}, {"gone", ""}, {"theirs", ""},
                                  {"text", ""}, {"plain", ""}});
  plant("t_far", "Far", owner, {{"on", "t_near"}});
  plant("t_near", "Near", owner, {{"back", "t_main"}});
  plant("t_x", "X", owner, {{"to-y", "t_y"}});
  plant("t_y", "Y", owner, {{"to-x", "t_x"}});
  plant("t_gone", "Gone", owner, {{"g", ""}});
  plant("t_theirs", "Theirs", stranger, {{"x", ""}});
  plant("t_plain", "Plain", owner, {{"p", ""}});
  h.trees->softDelete(TreeId{"t_gone"});

  CHECK_EQ(bodyOf(sendGetDiagnostics(h.api, "s-owner", "t_main")), parse(R"({
      "cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[
        {"node":"near","path":[{"treeId":"t_near","title":"Near"},{"treeId":"t_main","title":"Main"}]},
        {"node":"round","path":[{"treeId":"t_far","title":"Far"},{"treeId":"t_near","title":"Near"},{"treeId":"t_main","title":"Main"}]},
        {"node":"self","path":[{"treeId":"t_main","title":"Main"}]}],
      "danglingPointers":[{"node":"gone","treeId":"t_gone"},{"node":"text","treeId":"said \"so\""},
                          {"node":"theirs","treeId":"t_theirs"}]})"));
  CHECK_EQ(h.trees->openedReads,
           (std::vector<std::set<TreeId>>{{TreeId{"said \"so\""}, TreeId{"t_far"}, TreeId{"t_gone"}, TreeId{"t_main"},
                                           TreeId{"t_near"}, TreeId{"t_theirs"}, TreeId{"t_x"}}}));
  CHECK_EQ(bodyOf(sendGetDiagnostics(h.api, "s-owner", "t_plain")),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],"treeLoops":[],"danglingPointers":[]})"));
  CHECK_EQ(h.trees->openedReads.size(), 1u);

  h.trees->openedReadsFail = true;
  for (const char* reader : {"s-stranger", ""}) {
    const std::string pointed = dump(bodyOf(sendGetDiagnostics(h.api, reader, "t_main")));
    CHECK_EQ(pointed, std::string(R"({"cycles":[],"dangling":[],"maskedWork":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}]})"));
    CHECK_EQ(pointed, dump(bodyOf(sendGetDiagnostics(h.api, reader, "t_twin"))));
  }
  CHECK_EQ(h.trees->openedReads.size(), 1u);
}

// The graph's diagnostics do not depend on the other trees: a follow that fails leaves them whole under a 200, says the
// pointers were not followed, and is reported once under its own name.
TEST(get_diagnostics_whose_pointers_cannot_be_followed_answers_the_graphs_diagnostics_and_says_so_and_files_one_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_sub", "Deep dive", me, Visibility::private_);
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].state.nodes[0].opens = TreeId{"t_sub"};
  h.trees->byId["t_mine"].state.nodes[0].opensAt = Hlc{2, 0, "seed"};

  h.trees->openedReadsFail = true;
  const drogon::HttpResponsePtr degraded = sendGetDiagnostics(h.api, "s-me", "t_mine");

  REQUIRE_EQ(degraded->getStatusCode(), drogon::k200OK);
  CHECK_EQ(parse(dump(bodyOf(degraded))), parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["root"]}],
      "maskedWork":[],"pointerDiagnosticsUnavailable":true})"));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.diagnostics.follow roadmap rest failed ") + typeid(std::runtime_error).name()}));
  CHECK_EQ(parse(dump(bodyOf(sendGetDiagnostics(h.api, "", "t_mine")))),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["root"]}],"maskedWork":[]})"));
  CHECK_EQ(parse(dump(bodyOf(sendGetDiagnostics(h.api, "s-me", "t_sub")))),
           parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"},{"kind":"empty-icon","count":1,"nodes":["root"]}],"maskedWork":[],
               "treeLoops":[],"danglingPointers":[]})"));
  CHECK_EQ(reporter.failures->reports.size(), 1u);
}

// The reply follows the domain's caps, as the MCP door's does: fifty nodes of each list, eight trees of a way, and
// a count of what is left off.
TEST(get_diagnostics_lists_fifty_nodes_and_eight_trees_of_a_way_and_counts_the_rest) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  const auto numbered = [](const char* prefix, int k) { return std::string(prefix) + (k < 10 ? "0" : "") + std::to_string(k); };
  const auto plant = [&](const std::string& id, std::vector<std::pair<std::string, std::string>> nodes) {
    TreeData data;
    data.id = TreeId{id};
    for (const auto& [node, opens] : nodes) {
      NodeSpec spec;
      spec.id = NodeId{node};
      spec.label = node;
      spec.icon = "i";
      spec.opens = TreeId{opens};
      data.nodes.push_back(spec);
    }
    h.trees->byId[id] =
        StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {"Tree " + id, {}}, 0, owner, Visibility::private_};
  };
  std::vector<std::pair<std::string, std::string>> own;
  for (int k = 1; k <= 51; ++k) {
    own.emplace_back(numbered("l", k), "t_w01");
    own.emplace_back(numbered("g", k), numbered("t_gone", k));
  }
  plant("t_main", own);
  for (int k = 1; k <= 8; ++k) plant(numbered("t_w", k), {{"next", k < 8 ? numbered("t_w", k + 1) : std::string("t_main")}});

  Json::Value expected = parse(R"({"cycles":[],"dangling":[],"selfEdges":[],"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[],"treeLoopsOmitted":1,"danglingPointers":[],"danglingPointersOmitted":1})");
  for (int k = 1; k <= 50; ++k) {
    Json::Value loop(Json::objectValue);
    loop["node"] = numbered("l", k);
    for (int on = 1; on <= 8; ++on) {
      Json::Value tree(Json::objectValue);
      tree["treeId"] = numbered("t_w", on);
      tree["title"] = "Tree " + numbered("t_w", on);
      loop["path"].append(tree);
    }
    loop["pathOmitted"] = 1;
    expected["treeLoops"].append(loop);
    Json::Value dangling(Json::objectValue);
    dangling["node"] = numbered("g", k);
    dangling["treeId"] = numbered("t_gone", k);
    expected["danglingPointers"].append(dangling);
  }
  CHECK_EQ(parse(dump(bodyOf(sendGetDiagnostics(h.api, "s-owner", "t_main")))), expected);
}

// The graph's errors are cut as the MCP door cuts them: fifty of a list, ten members of a cycle, and a count of what
// is left off.
TEST(get_diagnostics_lists_fifty_of_each_error_and_ten_members_of_a_cycle_and_counts_the_rest) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  const auto numbered = [](const char* prefix, int k) { return std::string(prefix) + (k < 10 ? "0" : "") + std::to_string(k); };
  TreeData data;
  data.id = TreeId{"t_main"};
  for (int k = 1; k <= 11; ++k) {
    NodeSpec spec;
    spec.id = NodeId{numbered("c", k)};
    spec.icon = "i";
    spec.prerequisites = {NodeId{numbered("c", k == 1 ? 11 : k - 1)}};
    data.nodes.push_back(spec);
  }
  for (int k = 1; k <= 51; ++k) {
    NodeSpec spec;
    spec.id = NodeId{numbered("s", k)};
    spec.icon = "i";
    spec.prerequisites = {spec.id};
    data.nodes.push_back(spec);
  }
  h.trees->byId["t_main"] =
      StoredTree{LooseGraph(data, Hlc{1, 0, "seed"}).exportState(), LegendState{}, {"Broken", {}}, 0, owner, Visibility::private_};

  Json::Value expected = parse(R"({"cycles":[{"count":11,"nodes":["c01","c02","c03","c04","c05","c06","c07","c08","c09","c10"]}],
      "dangling":[],"selfEdges":[],"selfEdgesOmitted":1,"smells":[{"kind":"empty-legend"}],"maskedWork":[],
      "treeLoops":[],"danglingPointers":[]})");
  for (int k = 1; k <= 50; ++k) {
    Json::Value edge(Json::objectValue);
    edge["from"] = numbered("s", k);
    edge["to"] = numbered("s", k);
    expected["selfEdges"].append(edge);
  }
  CHECK_EQ(parse(dump(bodyOf(sendGetDiagnostics(h.api, "s-owner", "t_main")))), expected);
}

// An exhausted process must die rather than answer that the pointers could not be followed.
TEST(get_diagnostics_lets_an_exhausted_process_die_rather_than_answer) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_sub", "Deep dive", me, Visibility::private_);
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].state.nodes[0].opens = TreeId{"t_sub"};
  h.trees->byId["t_mine"].state.nodes[0].opensAt = Hlc{2, 0, "seed"};
  h.trees->duringOpenedRead = [] { throw std::bad_alloc{}; };

  bool propagated = false;
  try {
    sendGetDiagnostics(h.api, "s-me", "t_mine");
  } catch (const std::bad_alloc&) {
    propagated = true;
  }

  CHECK(propagated);
  CHECK_EQ(sendGetDiagnostics(h.api, "", "t_mine")->getStatusCode(), drogon::k200OK);
}

// A stranger's read must not wait on the owner's statement: that wait would say the tree holds a pointer.
TEST(get_diagnostics_follows_pointers_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  const UserId me = h.signIn("s-me");
  h.seed("t_sub", "Deep dive", me, Visibility::private_);
  h.seed("t_mine", "Learn to sail", me, Visibility::public_);
  h.trees->byId["t_mine"].state.nodes[0].opens = TreeId{"t_sub"};
  h.trees->byId["t_mine"].state.nodes[0].opensAt = Hlc{2, 0, "seed"};
  bool strandWasFree = false;
  drogon::HttpStatusCode readMeanwhile = drogon::kUnknown;
  h.trees->duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.rooms->strandFor(TreeId{"t_mine"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = sendGetDiagnostics(h.api, "", "t_mine")->getStatusCode();
    });
    other.join();
  };

  CHECK_EQ(sendGetDiagnostics(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);

  CHECK_EQ(h.trees->openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_sub"}}}));
  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, drogon::k200OK);
}

TEST(get_activity_private_denial_is_404_byte_identical_to_absent) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "Mine", me, Visibility::private_);
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_);

  CHECK_EQ(sendGetActivity(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr anon = sendGetActivity(h.api, "", "t_priv");
  drogon::HttpResponsePtr absent = sendGetActivity(h.api, "", "t_ghost");
  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(anon)), dump(bodyOf(absent)));
}

TEST(get_activity_unlisted_is_readable_by_anyone) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted);
  CHECK_EQ(sendGetActivity(h.api, "", "t_shared")->getStatusCode(), drogon::k200OK);
}

// ---- shared-tree progress follows ownership (the share shows the owner's journey) --------

TEST(get_progress_shows_the_owners_journey_to_an_anonymous_visitor) {
  Harness h;
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::unlisted);
  h.progress->setStatuses(TreeId{"t_shared"}, UserId{"owner"}, {{NodeId{"root"}, ProgressStatus::complete, false, Hlc{2, 0, "owner"}}}, StampedBy::replica, 2);

  drogon::HttpResponsePtr anon = sendGetProgress(h.api, "", "t_shared");
  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(soleCompleted(anon), std::string("root"));
}

TEST(get_progress_shows_the_same_journey_to_owner_and_stranger) {
  Harness h;
  UserId me = h.signIn("s-me", "me@example.com");
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::public_);
  h.progress->setStatuses(TreeId{"t_shared"}, UserId{"owner"}, {{NodeId{"root"}, ProgressStatus::complete, false, Hlc{2, 0, "owner"}}}, StampedBy::replica, 2);
  h.progress->setStatuses(TreeId{"t_shared"}, me, {{NodeId{"root"}, ProgressStatus::none, false, Hlc{2, 0, "me"}}}, StampedBy::replica, 2);

  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "s-me", "t_shared")), std::string("root"));
  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "", "t_shared")), std::string("root"));
}

TEST(get_progress_of_a_private_tree_is_404_for_a_non_owner_and_200_for_its_owner) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", owner, Visibility::private_);
  h.progress->setStatuses(TreeId{"t_priv"}, owner, {{NodeId{"root"}, ProgressStatus::complete, false, Hlc{2, 0, "o"}}}, StampedBy::replica, 2);

  CHECK_EQ(sendGetProgress(h.api, "s-other", "t_priv")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(sendGetProgress(h.api, "", "t_priv")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(soleCompleted(sendGetProgress(h.api, "s-owner", "t_priv")), std::string("root"));
}

// The owner's own reads show such a step done through its tree, so a reader served the stored marks saw a hole. A
// reader is shown what the owner's reads derive, and the owner, whose view derives it again, the marks as stored.
TEST(get_progress_shows_a_reader_the_owners_derived_completion_of_a_step_that_opens_a_tree_and_its_writer_the_stored_marks) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-other", "other@example.com");
  h.seedSteps("t_done", owner, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_open", owner, Visibility::private_, {{"o", ""}});
  h.seedSteps("t_removed", owner, Visibility::private_, {{"r", ""}});
  h.seedSteps("t_theirs", UserId{"someone-else"}, Visibility::public_, {{"x", ""}});
  h.trees->softDelete(TreeId{"t_removed"});
  h.seedSteps("t_main", owner, Visibility::public_,
              {{"done-cleared", "t_done"}, {"done-marked", "t_done"}, {"done-unmarked", "t_done"}, {"open", "t_open"},
               {"plain", ""}, {"removed", "t_removed"}, {"theirs", "t_theirs"}});
  h.progress->setStatuses(TreeId{"t_done"}, owner, {{NodeId{"d"}, ProgressStatus::complete, false, Hlc{800, 0, "owner"}}}, StampedBy::replica, 800);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"done-marked"}, ProgressStatus::complete, true, Hlc{900, 0, "owner"}}}, StampedBy::replica, 900);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"done-cleared"}, ProgressStatus::none, false, Hlc{901, 0, "owner"}}}, StampedBy::replica, 901);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"open"}, ProgressStatus::complete, false, Hlc{902, 0, "owner"}}}, StampedBy::replica, 902);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"removed"}, ProgressStatus::complete, false, Hlc{903, 0, "owner"}}}, StampedBy::replica, 903);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"theirs"}, ProgressStatus::none, false, Hlc{904, 0, "owner"}}}, StampedBy::replica, 904);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"plain"}, ProgressStatus::complete, false, Hlc{905, 0, "owner"}}}, StampedBy::replica, 905);

  const Json::Value shown = parse(R"({"marks":[
      {"node":"done-cleared","status":"complete","at":"800:0:owner","markedAt":800},
      {"node":"done-marked","status":"complete","at":"900:0:owner","markedAt":900},
      {"node":"done-unmarked","status":"complete","at":"800:0:owner","markedAt":800},
      {"node":"plain","status":"complete","at":"905:0:owner","markedAt":905},
      {"node":"removed","status":"complete","at":"903:0:owner","markedAt":903},
      {"node":"theirs","status":"none","at":"904:0:owner","markedAt":904}]})");
  for (const char* session : {"", "s-other"}) {
    const drogon::HttpResponsePtr reply = sendGetProgress(h.api, session, "t_main");
    REQUIRE_EQ(reply->getStatusCode(), drogon::k200OK);
    CHECK_EQ(parse(std::string(reply->getBody())), shown);
    CHECK_EQ(std::string(reply->getBody()).find("t_"), std::string::npos);
  }
  const std::set<TreeId> opened{TreeId{"t_done"}, TreeId{"t_open"}, TreeId{"t_removed"}, TreeId{"t_theirs"}};
  CHECK_EQ(h.trees->openedReads, (std::vector<std::set<TreeId>>{opened, opened}));

  CHECK_EQ(parse(std::string(sendGetProgress(h.api, "s-owner", "t_main")->getBody())), parse(R"({"marks":[
      {"node":"done-cleared","status":"none","at":"901:0:owner","markedAt":901},
      {"node":"done-marked","status":"complete","at":"900:0:owner","markedAt":900,"outOfOrder":true},
      {"node":"open","status":"complete","at":"902:0:owner","markedAt":902},
      {"node":"plain","status":"complete","at":"905:0:owner","markedAt":905},
      {"node":"removed","status":"complete","at":"903:0:owner","markedAt":903},
      {"node":"theirs","status":"none","at":"904:0:owner","markedAt":904}]})"));
  CHECK_EQ(h.trees->openedReads.size(), 2u);
}

// What a reader is answered must not say a step opens a tree: it is, byte for byte, the answer for a twin where a step
// that opens a tree that is not complete holds no mark and one that opens a complete tree was marked by hand at the
// latest mark in what completed that tree. A pointer that is not valid leaves its step the stored row.
TEST(get_progress_answers_a_reader_of_a_tree_with_pointers_what_a_twin_marked_by_hand_answers) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-other", "other@example.com");
  h.seedSteps("t_open", owner, Visibility::private_, {{"o", ""}, {"p", ""}});
  h.seedSteps("t_done", owner, Visibility::private_, {{"d", ""}, {"e", ""}});
  h.seedSteps("t_mid", owner, Visibility::private_, {{"deeper", "t_leaf"}, {"m", ""}});
  h.seedSteps("t_leaf", owner, Visibility::private_, {{"l", ""}});
  h.seedSteps("t_removed", owner, Visibility::private_, {{"r", ""}});
  h.seedSteps("t_theirs", UserId{"someone-else"}, Visibility::public_, {{"x", ""}});
  h.trees->softDelete(TreeId{"t_removed"});
  h.progress->setStatuses(TreeId{"t_open"}, owner, {{NodeId{"o"}, ProgressStatus::complete, false, Hlc{800, 0, "owner"}}}, StampedBy::replica, 800);
  h.progress->setStatuses(TreeId{"t_done"}, owner, {{NodeId{"d"}, ProgressStatus::complete, false, Hlc{700, 3, "phone"}}}, StampedBy::replica, 700);
  h.progress->setStatuses(TreeId{"t_done"}, owner, {{NodeId{"e"}, ProgressStatus::complete, false, Hlc{700, 2, "tablet"}}}, StampedBy::replica, 700);
  h.progress->setStatuses(TreeId{"t_mid"}, owner, {{NodeId{"m"}, ProgressStatus::complete, false, Hlc{600, 0, "phone"}}}, StampedBy::replica, 600);
  h.progress->setStatuses(TreeId{"t_leaf"}, owner, {{NodeId{"l"}, ProgressStatus::complete, false, Hlc{850, 0, "phone"}}}, StampedBy::replica, 850);
  h.seedSteps("t_main", owner, Visibility::public_,
              {{"chain", "t_mid"}, {"done", "t_done"}, {"done-marked", "t_done"}, {"marked", "t_open"}, {"unmarked", "t_open"},
               {"plain", ""}, {"removed", "t_removed"}, {"theirs", "t_theirs"}});
  h.seedSteps("t_twin", owner, Visibility::public_,
              {{"chain", ""}, {"done", ""}, {"done-marked", ""}, {"marked", ""}, {"unmarked", ""}, {"plain", ""}, {"removed", ""},
               {"theirs", ""}});
  for (const char* tree : {"t_main", "t_twin"}) {
    h.progress->setStatuses(TreeId{tree}, owner, {{NodeId{"plain"}, ProgressStatus::complete, false, Hlc{900, 0, "owner"}}}, StampedBy::replica, 900);
    h.progress->setStatuses(TreeId{tree}, owner, {{NodeId{"removed"}, ProgressStatus::complete, true, Hlc{901, 0, "owner"}}}, StampedBy::replica, 901);
    h.progress->setStatuses(TreeId{tree}, owner, {{NodeId{"theirs"}, ProgressStatus::none, false, Hlc{902, 0, "owner"}}}, StampedBy::replica, 902);
  }
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"marked"}, ProgressStatus::complete, false, Hlc{903, 0, "owner"}}}, StampedBy::replica, 903);
  h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{"done-marked"}, ProgressStatus::complete, true, Hlc{904, 0, "owner"}}}, StampedBy::replica, 904);
  h.progress->setStatuses(TreeId{"t_twin"}, owner, {{NodeId{"done-marked"}, ProgressStatus::complete, false, Hlc{904, 0, "owner"}}}, StampedBy::replica, 904);
  h.progress->setStatuses(TreeId{"t_twin"}, owner, {{NodeId{"done"}, ProgressStatus::complete, false, Hlc{700, 3, "phone"}}}, StampedBy::replica, 700);
  h.progress->setStatuses(TreeId{"t_twin"}, owner, {{NodeId{"chain"}, ProgressStatus::complete, false, Hlc{850, 0, "phone"}}}, StampedBy::replica, 850);

  for (const char* session : {"", "s-other"}) {
    const drogon::HttpResponsePtr onTheTree = sendGetProgress(h.api, session, "t_main");
    const drogon::HttpResponsePtr onTheTwin = sendGetProgress(h.api, session, "t_twin");
    REQUIRE_EQ(onTheTree->getStatusCode(), drogon::k200OK);
    CHECK_EQ(std::string(onTheTree->getBody()), std::string(onTheTwin->getBody()));
    CHECK_EQ(parse(std::string(onTheTree->getBody())), parse(R"({"marks":[
        {"node":"chain","status":"complete","at":"850:0:phone","markedAt":850},
        {"node":"done","status":"complete","at":"700:3:phone","markedAt":700},
        {"node":"done-marked","status":"complete","at":"904:0:owner","markedAt":904},
        {"node":"plain","status":"complete","at":"900:0:owner","markedAt":900},
        {"node":"removed","status":"complete","at":"901:0:owner","markedAt":901,"outOfOrder":true},
        {"node":"theirs","status":"none","at":"902:0:owner","markedAt":902}]})"));
  }
}

// A follow that fails or runs past its budget is not the reader's to wait on or be refused for: the route answers, and
// leaves out the row of every step that holds a pointer, so none is shown done that may not be. For five minutes after,
// the owner is left unread without a try; the next try that fails says so again.
TEST(get_progress_whose_pointers_cannot_be_followed_in_time_answers_a_reader_without_the_steps_that_open_a_tree) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.seedSteps("t_done", owner, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_main", owner, Visibility::public_, {{"done", "t_done"}, {"gone", "t_gone"}, {"plain", ""}});
  h.progress->setStatuses(TreeId{"t_done"}, owner, {{NodeId{"d"}, ProgressStatus::complete, false, Hlc{800, 0, "owner"}}}, StampedBy::replica, 800);
  for (const char* step : {"done", "gone", "plain"})
    h.progress->setStatuses(TreeId{"t_main"}, owner, {{NodeId{step}, ProgressStatus::complete, false, Hlc{900, 0, "owner"}}}, StampedBy::replica, 900);
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    if (line.product == "roadmap") lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });

  const drogon::HttpResponsePtr followed = sendGetProgress(h.api, "", "t_main");
  h.trees->budgetedReadsTimeOut = true;
  const drogon::HttpResponsePtr timedOut = sendGetProgress(h.api, "", "t_main");
  h.trees->budgetedReadsTimeOut = false;
  const drogon::HttpResponsePtr coolingOff = sendGetProgress(h.api, "", "t_main");
  h.clock->now += 5 * 60 * 1000;
  h.trees->openedReadsFail = true;
  const drogon::HttpResponsePtr failed = sendGetProgress(h.api, "", "t_main");
  const drogon::HttpResponsePtr owners = sendGetProgress(h.api, "s-owner", "t_main");
  installWriteSink({});

  const Json::Value withoutPointerSteps = parse(R"({"marks":[{"node":"plain","status":"complete","at":"900:0:owner","markedAt":900}]})");
  CHECK_EQ(parse(std::string(followed->getBody())), parse(R"({"marks":[
      {"node":"done","status":"complete","at":"900:0:owner","markedAt":900},
      {"node":"gone","status":"complete","at":"900:0:owner","markedAt":900},
      {"node":"plain","status":"complete","at":"900:0:owner","markedAt":900}]})"));
  for (const drogon::HttpResponsePtr& reply : {timedOut, coolingOff, failed}) {
    CHECK_EQ(reply->getStatusCode(), drogon::k200OK);
    CHECK_EQ(parse(std::string(reply->getBody())), withoutPointerSteps);
  }
  CHECK_EQ(bodyOf(owners)["marks"].size(), 3u);
  CHECK_EQ(lines, (std::vector<std::string>{"roadmap.progress.follow roadmap rest timeout", "roadmap.progress.follow roadmap rest failed"}));
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.progress.follow roadmap rest failed ") + typeid(std::runtime_error).name()}));
  CHECK_EQ(h.trees->openedBudgets, (std::vector<std::optional<std::chrono::milliseconds>>(3, std::chrono::milliseconds{750})));
}

// Nothing is followed where following decides nothing: for the tree's writer, and for a tree no step of which opens one.
TEST(get_progress_follows_no_pointer_for_the_trees_writer_or_for_a_tree_that_holds_none_and_leaves_no_line) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.seedSteps("t_sub", owner, Visibility::private_, {{"s", ""}});
  h.seedSteps("t_main", owner, Visibility::public_, {{"idea", "t_sub"}, {"plain", ""}});
  h.seedSteps("t_plain", owner, Visibility::public_, {{"idea", ""}, {"plain", ""}});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    if (line.product == "roadmap") lines.push_back(line.operation + " " + line.outcome);
  });

  CHECK_EQ(sendGetProgress(h.api, "s-owner", "t_main")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendGetProgress(h.api, "", "t_plain")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendGetProgress(h.api, "s-owner", "t_plain")->getStatusCode(), drogon::k200OK);
  installWriteSink({});

  CHECK(h.trees->openedReads.empty());
  CHECK(lines.empty());
}

// Another reader of the tree must not wait on the follow one reader's answer makes.
TEST(get_progress_follows_pointers_for_a_reader_after_it_has_let_go_of_the_trees_strand) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.seedSteps("t_sub", owner, Visibility::private_, {{"s", ""}});
  h.seedSteps("t_main", owner, Visibility::public_, {{"idea", "t_sub"}, {"plain", ""}});
  bool strandWasFree = false;
  drogon::HttpStatusCode readMeanwhile = drogon::kUnknown;
  h.trees->duringOpenedRead = [&] {
    std::thread other([&] {
      std::mutex& strand = h.rooms->strandFor(TreeId{"t_main"});
      if (!strand.try_lock()) return;
      strand.unlock();
      strandWasFree = true;
      readMeanwhile = sendGetTree(h.api, "", "t_main")->getStatusCode();
    });
    other.join();
  };

  CHECK_EQ(sendGetProgress(h.api, "", "t_main")->getStatusCode(), drogon::k200OK);

  CHECK_EQ(h.trees->openedReads.size(), 1u);
  CHECK(strandWasFree);
  CHECK_EQ(readMeanwhile, drogon::k200OK);
}

TEST(fork_of_a_private_source_you_dont_own_is_404_like_absent) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_priv", "Someone's private plan", UserId{"owner"}, Visibility::private_);

  drogon::HttpResponsePtr denied = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_priv");
  drogon::HttpResponsePtr absent = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_ghost");

  CHECK_EQ(denied->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(absent->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(denied)), dump(bodyOf(absent)));
  CHECK(h.trees->forkedFrom.empty());
}

// The request exception boundary answers 500 and reports the Issue; a 404 here would hide the failure.
TEST(fork_lets_an_infrastructure_failure_reach_the_request_exception_boundary) {
  Harness h;
  h.signIn("s-me");
  h.seedSource("t_src", "Learn to sail");
  h.trees->latticeLoadsFail = true;

  bool threw = false;
  drogon::HttpResponsePtr response;
  try {
    response = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_src");
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(response == nullptr);
  CHECK(h.trees->forkedFrom.empty());
}

TEST(fork_of_your_own_private_source_succeeds) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", "My private plan", me, Visibility::private_);

  drogon::HttpResponsePtr response = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-me"), "t_priv");
  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(h.trees->forkedFrom["t_d1"], std::string("t_priv"));
}

// ---- PUT /v1/trees/{id} : the write gate, and a tree born owned -----------------------------

TEST(put_by_an_anonymous_caller_is_401_and_writes_nothing) {
  Harness h;

  drogon::HttpResponsePtr response = sendPut(h.api, "", "t_00000000000000e0", document("Mine", "a"));

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"sign in to edit"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e0"), std::size_t{0});
}

TEST(put_to_an_unowned_tree_is_403_and_leaves_it_unowned_and_unmodified) {
  Harness h;
  h.signIn("s-visitor", "visitor@example.com");
  h.seed("t_00000000000000de", "Learn to sail", UserId{"placeholder"}, Visibility::public_);
  h.trees->byId["t_00000000000000de"].owner = std::nullopt;  // the demo row: owner NULL, visibility public
  const StoredTree before = h.trees->byId["t_00000000000000de"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-visitor", "t_00000000000000de", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(bodyOf(response)["code"].asString(), std::string("nobodys-tree"));
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, or fork it into a roadmap of your own"));
  CHECK_FALSE(h.trees->byId["t_00000000000000de"].owner.has_value());
  CHECK(h.trees->byId["t_00000000000000de"] == before);
  CHECK_EQ(storedNodeIds(*h.trees, "t_00000000000000de"), std::vector<std::string>{"root"});
}

TEST(put_to_someone_elses_readable_tree_is_403_and_writes_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_000000000000ffee", "Theirs", UserId{"owner"}, Visibility::unlisted);
  const StoredTree before = h.trees->byId["t_000000000000ffee"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-other", "t_000000000000ffee", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"code":"not-yours","error":"this tree belongs to another account"})"));
  CHECK(h.trees->byId["t_000000000000ffee"] == before);
  CHECK(h.trees->byId["t_000000000000ffee"].owner == std::optional<UserId>(UserId{"owner"}));
}

TEST(put_to_a_private_tree_you_cannot_read_is_404_and_writes_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_00000000000000aa", "Secret", UserId{"owner"}, Visibility::private_);
  const StoredTree before = h.trees->byId["t_00000000000000aa"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-other", "t_00000000000000aa", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such tree"})"));
  CHECK(h.trees->byId["t_00000000000000aa"] == before);
}

TEST(put_to_an_unowned_private_tree_is_404_and_writes_nothing) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_0000000000000bbb", "Orphan", UserId{"placeholder"}, Visibility::private_);
  h.trees->byId["t_0000000000000bbb"].owner = std::nullopt;
  const StoredTree before = h.trees->byId["t_0000000000000bbb"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000bbb", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK(h.trees->byId["t_0000000000000bbb"] == before);
  CHECK_FALSE(h.trees->byId["t_0000000000000bbb"].owner.has_value());
}

TEST(put_to_an_absent_id_creates_a_tree_owned_by_the_caller) {
  Harness h;
  UserId me = h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e0", document("Learn to sail", "hull"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = bodyOf(response);
  CHECK_EQ(body["seq"].asInt64(), 0);
  CHECK_EQ(body["data"]["id"].asString(), std::string("t_00000000000000e0"));
  CHECK_EQ(body["data"]["title"].asString(), std::string("Learn to sail"));
  CHECK_EQ(body["data"]["kinds"].size(), 3u);

  REQUIRE_EQ(h.trees->byId.count("t_00000000000000e0"), std::size_t{1});
  CHECK(h.trees->byId["t_00000000000000e0"].owner == std::optional<UserId>(me));
  CHECK(h.trees->byId["t_00000000000000e0"].visibility == Visibility::private_);
  CHECK_EQ(h.trees->byId["t_00000000000000e0"].title.value, std::string("Learn to sail"));
  CHECK_EQ(storedNodeIds(*h.trees, "t_00000000000000e0"), std::vector<std::string>{"hull"});
}

TEST(put_to_an_absent_id_adds_its_steps_now_and_a_put_into_a_standing_tree_stays_at_genesis) {
  Harness h;
  h.clock->now = 1'800'000'000'000;
  UserId me = h.signIn("s-me");
  const Hlc genesis{1, 0, "genesis"};

  CHECK_EQ(sendPut(h.api, "s-me", "t_00000000000000e1", document("Learn to sail", "hull"))->getStatusCode(),
           drogon::k200OK);
  const StoredTree& created = h.trees->byId["t_00000000000000e1"];
  REQUIRE_EQ(created.state.nodes.size(), 1u);
  CHECK_EQ(created.state.nodes[0].createdAt, (Hlc{1'800'000'000'000, 0, "srv"}));
  CHECK_EQ(created.state.nodes[0].labelAt, (Hlc{1'800'000'000'000, 0, "srv"}));
  REQUIRE_EQ(created.legend.kinds.size(), 3u);
  for (const KindStateEntry& kind : created.legend.kinds) CHECK_EQ(kind.createdAt, genesis);

  h.seed("t_00000000000000e2", "Standing", me, Visibility::unlisted);
  CHECK_EQ(sendPut(h.api, "s-me", "t_00000000000000e2", document("Standing", "mast"))->getStatusCode(),
           drogon::k200OK);
  const std::optional<NodeStateEntry> mast = LooseGraph(h.trees->byId["t_00000000000000e2"].state).exportNode(NodeId{"mast"});
  REQUIRE(mast.has_value());
  CHECK_EQ(mast->createdAt, genesis);
}

// A node has no stored position: a document that still sends one with a node, of any shape, lands exactly as its twin
// without it, and no read answers one, in the document or in the lattice.
TEST(put_takes_a_node_that_still_sends_a_position_and_no_read_answers_one) {
  Harness h;
  h.signIn("s-me");
  Json::Value placed = document("Placed", "hull");
  placed["nodes"][0]["position"] = parse(R"({"x":3,"y":4})");
  Json::Value misplaced = document("Placed", "hull");
  misplaced["nodes"][0]["position"] = "left of the mast";
  const Json::Value plain = document("Placed", "hull");

  drogon::HttpResponsePtr withPosition = sendPut(h.api, "s-me", "t_00000000000000f2", placed);
  drogon::HttpResponsePtr without = sendPut(h.api, "s-me", "t_00000000000000f3", plain);

  CHECK_EQ(withPosition->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendPut(h.api, "s-me", "t_00000000000000f4", misplaced)->getStatusCode(), drogon::k200OK);
  Json::Value placedRead = bodyOf(sendGetTree(h.api, "s-me", "t_00000000000000f2"));
  Json::Value plainRead = bodyOf(sendGetTree(h.api, "s-me", "t_00000000000000f3"));
  for (Json::Value* read : {&placedRead, &plainRead}) {
    read->removeMember("createdAt");
    read->removeMember("root");
    (*read)["data"].removeMember("id");
    (*read)["state"].removeMember("treeId");
  }
  CHECK_EQ(placedRead, plainRead);
  CHECK_EQ(bodyOf(withPosition)["data"]["nodes"], bodyOf(without)["data"]["nodes"]);
}

// A kind has no cross-branch flag: a document that still sends one, as a bool or as anything else, lands as one that
// does not, and no read answers it.
TEST(put_takes_a_kind_that_still_sends_a_cross_branch_flag_and_no_read_answers_one) {
  Harness h;
  h.signIn("s-me");
  Json::Value sent = document("Flagged", "hull");
  sent["kinds"] = parse(R"([{"id":"drill","hue":"gold","label":"Drill","description":"","crossBranchExempt":true},
    {"id":"build","hue":"sky","label":"Build","description":"","crossBranchExempt":"yes"}])");
  const Json::Value kinds = parse(R"([{"id":"drill","hue":"gold","label":"Drill","description":""},
    {"id":"build","hue":"sky","label":"Build","description":""}])");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000f1", sent);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["kinds"], kinds);
  CHECK_EQ(bodyOf(sendGetTree(h.api, "s-me", "t_00000000000000f1"))["data"]["kinds"], kinds);
}

TEST(put_by_the_owner_overwrites_the_document_and_keeps_the_owner) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("New name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string("New name"));
  CHECK(h.trees->byId["t_00000000000000cc"].owner == std::optional<UserId>(me));
  CHECK(h.trees->byId["t_00000000000000cc"].visibility == Visibility::unlisted);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("New name"));
  // The lattice is entry-grow-only: a save adds and overwrites entries, never deletes rows.
  std::vector<std::string> ids = storedNodeIds(*h.trees, "t_00000000000000cc");
  std::sort(ids.begin(), ids.end());
  CHECK_EQ(ids, (std::vector<std::string>{"mast", "root"}));
}

TEST(put_to_a_malformed_id_is_400_bad_id_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "audit-weird-id", document("Mine", "a"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"code":"bad-id","error":"id must be t_ followed by 16 lowercase hex characters"})"));
  CHECK_EQ(h.trees->byId.count("audit-weird-id"), std::size_t{0});
}

TEST(put_with_a_wrong_typed_field_is_400_not_500_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "x";
  body["nodes"] = Json::Value(Json::arrayValue);
  body["nodes"].append(1);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e1", body);

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"invalid json body"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e1"), std::size_t{0});
}

TEST(put_with_an_oversized_field_is_400_naming_the_node_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body = document("Mine", "hull");
  body["nodes"][0]["label"] = std::string(kMaxNodeLabelLength + 1, 'x');

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e2", body);

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"node \"hull\": label would be 201 characters, 1 over the 200 cap"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e2"), std::size_t{0});
}

TEST(put_with_an_opens_past_the_id_cap_is_400_naming_the_node_and_one_at_the_cap_is_stored) {
  Harness h;
  h.signIn("s-me");
  Json::Value body = document("Mine", "hull");
  body["nodes"][0]["opens"] = std::string(kMaxIdLength + 1, 't');

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000e4", body);

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)),
           std::string(R"({"error":"node \"hull\": opens would be 129 characters, 1 over the 128 cap"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e4"), std::size_t{0});

  body["nodes"][0]["opens"] = std::string(kMaxIdLength, 't');
  CHECK_EQ(sendPut(h.api, "s-me", "t_00000000000000e4", body)->getStatusCode(), drogon::k200OK);
  REQUIRE_EQ(h.trees->byId["t_00000000000000e4"].state.nodes.size(), 1u);
  CHECK_EQ(h.trees->byId["t_00000000000000e4"].state.nodes[0].opens, TreeId{std::string(kMaxIdLength, 't')});
}

TEST(put_over_the_edge_ceiling_is_413_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "Too tangled";
  body["nodes"] = Json::Value(Json::arrayValue);
  // Five hubs and 4001 steps requiring all five: 20005 edges over 4006 nodes — under the node ceiling, over the edge one.
  for (int hub = 0; hub < 5; ++hub) {
    Json::Value node(Json::objectValue);
    node["id"] = "hub" + std::to_string(hub);
    body["nodes"].append(node);
  }
  for (std::size_t i = 0; i <= kMaxEdges / 5; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    node["prerequisites"] = Json::Value(Json::arrayValue);
    for (int hub = 0; hub < 5; ++hub) node["prerequisites"].append("hub" + std::to_string(hub));
    body["nodes"].append(node);
  }

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000b17", body);

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(bodyOf(response)["error"].asString(),
           std::string("this tree would hold 20005 edges, max 20000 — remove edges with change_edges before "
                       "adding more"));
  CHECK_EQ(h.trees->byId.count("t_0000000000000b17"), std::size_t{0});
}

TEST(put_over_the_node_ceiling_is_413_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body(Json::objectValue);
  body["title"] = "Too big";
  body["nodes"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i <= kMaxNodes; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    body["nodes"].append(node);
  }

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_0000000000000b16", body);

  CHECK_EQ(response->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(h.trees->byId.count("t_0000000000000b16"), std::size_t{0});
}

// ---- PUT and the live room: gate first, evict second ---------------------------------------

TEST(a_refused_put_leaves_the_owners_live_room_open_and_untouched) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner-acct@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_000000000000ffee", "Theirs", owner, Visibility::unlisted);
  editInTheLiveRoom(h, "t_000000000000ffee", "owner-step", owner);
  const StoredTree before = h.trees->byId["t_000000000000ffee"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-stranger", "t_000000000000ffee", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK(h.rooms->isOpen(TreeId{"t_000000000000ffee"}));
  CHECK(h.trees->savedNodeCounts.empty());
  CHECK(h.trees->byId["t_000000000000ffee"] == before);
}

TEST(a_put_to_a_private_tree_you_cannot_read_leaves_its_live_room_open_and_untouched) {
  Harness h;
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_00000000000000aa", "Secret", UserId{"owner"}, Visibility::private_);
  editInTheLiveRoom(h, "t_00000000000000aa", "private-step", UserId{"owner"});
  const StoredTree before = h.trees->byId["t_00000000000000aa"];

  drogon::HttpResponsePtr response = sendPut(h.api, "s-stranger", "t_00000000000000aa", document("Mine now", "seized"));

  CHECK_EQ(response->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"no such tree"})"));
  CHECK(h.rooms->isOpen(TreeId{"t_00000000000000aa"}));
  CHECK(h.trees->savedNodeCounts.empty());
  CHECK(h.trees->byId["t_00000000000000aa"] == before);
}

TEST(put_over_a_live_room_saves_at_the_rooms_head_so_no_op_tail_replays_over_it) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);
  editInTheLiveRoom(h, "t_00000000000000cc", "socket-step", me);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].head, Seq{0});  // the row is behind the room by one op
  CHECK(h.ops->byTree["t_00000000000000cc"].empty());            // whose row is queued, not yet landed

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("New name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].head, Seq{1});
  CHECK_EQ(bodyOf(response)["seq"].asInt64(), 1);
  REQUIRE_EQ(h.ops->byTree["t_00000000000000cc"].size(), 1u);   // the flush landed the row behind the save
  CHECK_EQ(h.ops->byTree["t_00000000000000cc"][0].seq, Seq{1});
  CHECK(h.ops->since(TreeId{"t_00000000000000cc"}, h.trees->byId["t_00000000000000cc"].head).empty());
}

TEST(put_leaves_the_guide_alone_and_answers_with_the_one_the_tree_holds) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cd", "Old name", me, Visibility::unlisted);
  const Lww<std::string> guide{"Rig first, then sail.", Hlc{5, 0, "srv"}};
  h.trees->byId["t_00000000000000cd"].guide = guide;
  Json::Value posted = document("New name", "mast");
  posted["guide"] = "Overwritten by a document";

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cd", posted);

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["guide"].asString(), guide.value);
  CHECK(h.trees->byId["t_00000000000000cd"].guide == guide);
}

TEST(put_over_a_live_room_mints_its_title_past_the_rooms_rename_not_the_stale_row) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_00000000000000cc", "Old name", me, Visibility::unlisted);
  {
    std::lock_guard<std::mutex> lock(h.rooms->strandFor(TreeId{"t_00000000000000cc"}));
    h.rooms->open(TreeId{"t_00000000000000cc"})->rename("Renamed over the socket", 5'000);
  }
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Old name"));

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "t_00000000000000cc", document("Posted name", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string("Posted name"));
  CHECK_EQ(h.trees->byId["t_00000000000000cc"].title.value, std::string("Posted name"));
  CHECK(h.trees->byId["t_00000000000000cc"].title.stamp == (Hlc{5'000, 1, "srv"}));
}

TEST(repeated_puts_of_fresh_ids_cannot_walk_a_tree_past_the_node_ceiling) {
  Harness h;
  h.signIn("s-me");
  const std::string id = "t_0000000000000c01";
  auto batch = [](std::size_t from, std::size_t count) {
    Json::Value body(Json::objectValue);
    body["title"] = "Growing";
    body["nodes"] = Json::Value(Json::arrayValue);
    for (std::size_t i = from; i < from + count; ++i) {
      Json::Value node(Json::objectValue);
      node["id"] = "n" + std::to_string(i);
      body["nodes"].append(node);
    }
    return body;
  };

  CHECK_EQ(sendPut(h.api, "s-me", id, batch(0, 6000))->getStatusCode(), drogon::k200OK);
  drogon::HttpResponsePtr second = sendPut(h.api, "s-me", id, batch(6000, 6000));

  CHECK_EQ(second->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(bodyOf(second)["error"].asString(),
           std::string("this tree would hold 12000 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
  CHECK_EQ(storedNodeIds(*h.trees, id).size(), std::size_t{6000});
}

TEST(a_put_that_re_sends_the_nodes_already_stored_is_still_admitted) {
  Harness h;
  h.signIn("s-me");
  const std::string id = "t_0000000000000c02";
  Json::Value body(Json::objectValue);
  body["title"] = "Steady";
  body["nodes"] = Json::Value(Json::arrayValue);
  for (std::size_t i = 0; i < kMaxNodes; ++i) {
    Json::Value node(Json::objectValue);
    node["id"] = "n" + std::to_string(i);
    body["nodes"].append(node);
  }

  CHECK_EQ(sendPut(h.api, "s-me", id, body)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(sendPut(h.api, "s-me", id, body)->getStatusCode(), drogon::k200OK);
  CHECK_EQ(storedNodeIds(*h.trees, id).size(), kMaxNodes);
}

// The id shape is a MINT rule: it binds the PUT that creates and nothing else — slug ids (`windmill-roadmap`, `demo`) are the contract in db/schema.sql.
TEST(put_to_an_existing_slug_id_tree_is_still_the_owners_to_write) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("windmill-roadmap", "The roadmap", me, Visibility::unlisted);

  drogon::HttpResponsePtr response = sendPut(h.api, "s-me", "windmill-roadmap", document("Renamed", "mast"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(h.trees->byId["windmill-roadmap"].title.value, std::string("Renamed"));
}

TEST(put_and_fork_refuse_a_non_object_json_root_with_400) {
  Harness h;
  h.signIn("s-me");
  h.seedSource("t_src", "Learn to sail");

  for (const char* body : {"[]", "\"hello\"", "5"}) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Put);
    request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    request->setBody(body);
    request->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr captured;
    h.api.putTree(request, [&](const drogon::HttpResponsePtr& r) { captured = r; }, "t_0000000000000c03");
    CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(captured)), std::string(R"({"error":"invalid json body"})"));

    auto fork = drogon::HttpRequest::newHttpRequest();
    fork->setMethod(drogon::Post);
    fork->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    fork->setBody(body);
    fork->addCookie("wm_session", "s-me");
    drogon::HttpResponsePtr forked;
    h.api.forkTree(fork, [&](const drogon::HttpResponsePtr& r) { forked = r; }, "t_src");
    CHECK_EQ(forked->getStatusCode(), drogon::k400BadRequest);
    CHECK_EQ(dump(bodyOf(forked)), std::string(R"({"error":"invalid json body"})"));
  }
  CHECK_EQ(h.trees->byId.count("t_0000000000000c03"), std::size_t{0});
}

// The bytes are spliced into the request text after serialization: the JSON writer would rewrite
// them, and it is the raw client bytes the door must judge.
TEST(put_with_a_field_that_is_not_valid_utf8_is_400_naming_the_field_and_creates_nothing) {
  Harness h;
  h.signIn("s-me");
  Json::Value body = document("Mine", "hull");
  body["nodes"][0]["description"] = "RAW";
  std::string text = dump(body);
  text.replace(text.find("RAW"), 3, std::string(100000, '\x80'));  // zero code points, so no cap would catch it

  drogon::HttpResponsePtr response = sendPutText(h.api, "s-me", "t_00000000000000e3", text);
  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"node \"hull\": description is not valid UTF-8"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e3"), std::size_t{0});

  std::string titled = dump(document("RAW", "hull"));
  titled.replace(titled.find("RAW"), 3, "\xE2\x82");
  response = sendPutText(h.api, "s-me", "t_00000000000000e3", titled);
  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"the title is not valid UTF-8"})"));
  CHECK_EQ(h.trees->byId.count("t_00000000000000e3"), std::size_t{0});
}

TEST(a_tree_read_that_fails_still_answers_404_and_files_one_issue_under_a_static_operation_per_request) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  struct ReporterScope {
    std::shared_ptr<Failures> failures = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(failures); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } reporter;
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "Learn to sail", me, Visibility::private_);

  drogon::HttpResponsePtr absent = sendGetTree(h.api, "s-me", "t_ghost");
  CHECK(reporter.failures->reports.empty());

  h.trees->latticeLoadsFail = true;
  drogon::HttpResponsePtr failed = sendGetTree(h.api, "s-me", "t_mine");
  REQUIRE_EQ(failed->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(dump(bodyOf(failed)), dump(bodyOf(absent)));
  CHECK_EQ(sendGetDiagnostics(h.api, "s-me", "t_mine")->getStatusCode(), drogon::k404NotFound);

  const std::string issue = std::string("roadmap.tree.read roadmap rest failed ") + typeid(std::runtime_error).name();
  CHECK_EQ(reporter.failures->reports, (std::vector<std::string>{issue, issue}));
  for (const std::string& report : reporter.failures->reports)
    CHECK(report.find("connection reset") == std::string::npos);
}

// A subtree opens by its own id for anyone who may read its root: named by its owning step's label and placed under it,
// root first. A root answers its own name, no parent, an empty path and depth 0. A stranger to a private root is
// answered as for an absent tree.
TEST(get_tree_answers_a_grandchilds_name_and_its_way_down_from_its_root_to_anyone_who_may_read_the_root) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seedForest(owner, Visibility::unlisted);
  const Json::Value grandchild = parse(R"({"root":"t_a","parent":{"tree":"t_s","step":"rig"},"path":[)"
                                       R"({"tree":"t_a","step":"sail","title":"My year"},)"
                                       R"({"tree":"t_s","step":"rig","title":"Learn to sail"}],"depth":2})");

  for (const char* session : {"s-owner", "s-stranger", ""}) {
    const drogon::HttpResponsePtr read = sendGetTree(h.api, session, "t_r");
    REQUIRE_EQ(read->getStatusCode(), drogon::k200OK);
    const Json::Value body = *read->getJsonObject();
    for (const char* key : {"root", "parent", "path", "depth"}) CHECK_EQ(body[key], grandchild[key]);
    CHECK_EQ(body["data"]["title"].asString(), std::string("Rig the boat"));
  }
  const Json::Value root = *sendGetTree(h.api, "", "t_a")->getJsonObject();
  CHECK_EQ(root["root"], Json::Value("t_a"));
  CHECK(root["parent"].isNull());
  CHECK_EQ(root["path"], Json::Value(Json::arrayValue));
  CHECK_EQ(root["depth"], Json::Value(0));
  CHECK_EQ(root["data"]["title"].asString(), std::string("My year"));

  h.rooms->sweep(std::chrono::steady_clock::duration::zero());
  h.trees->byId["t_a"].visibility = Visibility::private_;
  CHECK_EQ(sendGetTree(h.api, "s-stranger", "t_r")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(sendGetTree(h.api, "s-owner", "t_r")->getStatusCode(), drogon::k200OK);
}

// A step that owns a subtree carries what the subtree comes to for its owner on every node read, its writer's and its
// readers' alike, and no other step carries one: done once every step below is, however deep, open again when a leaf
// reopens. Only the writer is told the pointers, the owning step's among them. A reader whose owner cannot be followed is
// told the subtree alone.
TEST(get_tree_tells_every_reader_what_a_step_owning_a_subtree_comes_to_for_the_owner) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedForest(owner, Visibility::unlisted);
  h.mark("t_r", owner, "bowline", ProgressStatus::complete, 10);
  const auto nodesOf = [&](const char* session) {
    const drogon::HttpResponsePtr read = sendGetTree(h.api, session, "t_a");
    CHECK_EQ(read->getStatusCode(), drogon::k200OK);
    std::map<std::string, Json::Value> nodes;
    for (const Json::Value& node : (*read->getJsonObject())["data"]["nodes"]) nodes[node["id"].asString()] = node;
    return nodes;
  };
  const Json::Value open = parse(R"({"id":"t_s","done":1,"total":2,"state":"open"})");

  std::map<std::string, Json::Value> written = nodesOf("s-owner");
  CHECK_EQ(written["sail"]["subtree"], open);
  CHECK_EQ(written["sail"]["opens"], Json::Value("t_s"));
  CHECK_FALSE(written["coast"].isMember("subtree"));
  CHECK_EQ((*sendGetTree(h.api, "s-owner", "t_a")->getJsonObject())["opens"],
           parse(R"({"sail":{"treeId":"t_s","title":"Learn to sail","state":"open","done":1,"total":2,"loop":false}})"));
  std::map<std::string, Json::Value> read = nodesOf("");
  CHECK_EQ(read["sail"]["subtree"], open);
  CHECK_FALSE(read["sail"].isMember("opens"));
  CHECK_FALSE(read["coast"].isMember("subtree"));
  CHECK_FALSE((*sendGetTree(h.api, "", "t_a")->getJsonObject()).isMember("opens"));

  h.mark("t_s", owner, "knot", ProgressStatus::complete, 11);
  const Json::Value complete = parse(R"({"id":"t_s","done":2,"total":2,"state":"complete"})");
  CHECK_EQ(nodesOf("s-owner")["sail"]["subtree"], complete);
  CHECK_EQ(nodesOf("")["sail"]["subtree"], complete);
  h.mark("t_r", owner, "bowline", ProgressStatus::none, 12);
  CHECK_EQ(nodesOf("")["sail"]["subtree"], open);

  h.trees->openedReadsFail = true;
  CHECK_EQ(nodesOf("")["sail"]["subtree"], parse(R"({"id":"t_s"})"));
  CHECK_EQ(sendGetTree(h.api, "s-owner", "t_a")->getStatusCode(), drogon::k503ServiceUnavailable);
}
