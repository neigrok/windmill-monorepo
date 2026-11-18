#include "products/roadmap/adapters/http/TreeApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/application/ForkService.h"
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
  HeldRetries retries;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus, retries.timer());
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, *clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<ForkService> fork = std::make_shared<ForkService>(*rooms, *trees, tokens, *clock);
  std::shared_ptr<OwnerProgress> ownerProgress = std::make_shared<OwnerProgress>(*progress, *trees, *clock);
  TreeApi api{rooms, trees, ownerProgress, ops, auth, fork};

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

// The name a fork is asked to carry is held to the cap a title is, in the words a document's title is refused in.
TEST(fork_refuses_a_requested_title_past_its_cap_and_copies_nothing) {
  Harness h;
  h.signIn("s-live");
  h.seedSource("t_src", "Learn to sail");
  Json::Value named(Json::objectValue);
  named["title"] = std::string(250, 'x');

  drogon::HttpResponsePtr response = sendFork(h.api, forkRequest(named, "s-live"), "t_src");
  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"error":"the title would be 250 characters, 50 over the 200 cap"})"));
  CHECK_EQ(h.trees->byId.size(), 1u);
  CHECK(h.trees->forkedFrom.empty());

  named["title"] = std::string(200, 'x');
  response = sendFork(h.api, forkRequest(named, "s-live"), "t_src");
  CHECK_EQ(response->getStatusCode(), drogon::k201Created);
  CHECK_EQ(bodyOf(response)["data"]["title"].asString(), std::string(200, 'x'));
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
  const UserId stranger = h.signIn("s-stranger", "stranger@example.com");
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
  h.seedSteps("t_00000000000000a1", stranger, Visibility::private_, {{"pointer", "t_leaf"}});
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

TEST(fork_refuses_a_non_object_json_root_with_400) {
  Harness h;
  h.signIn("s-me");
  h.seedSource("t_src", "Learn to sail");

  for (const char* body : {"[]", "\"hello\"", "5"}) {
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
  CHECK_EQ(h.trees->byId.size(), 1u);
  CHECK(h.trees->forkedFrom.empty());
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

// A subtree's name and place are read once its strand is released: a read that fails answers as an absent tree does,
// the tree read and the guides read alike, each under one Issue of the place read's own, and a root, whose place is its
// own, makes no such read.
TEST(get_tree_of_a_subtree_whose_place_cannot_be_read_answers_404_under_one_issue) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::string& exceptionType) override {
      reports.push_back(operation + " " + product + " " + door + " " + outcome + " " + exceptionType);
    }
  };
  std::shared_ptr<Failures> failures = std::make_shared<Failures>();
  installWriteReporter(failures);
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedForest(owner, Visibility::unlisted);
  h.trees->placeReadsFail = true;

  const drogon::HttpResponsePtr subtree = sendGetTree(h.api, "", "t_s");
  const drogon::HttpResponsePtr guides = sendGetGuides(h.api, "s-owner", "t_s");
  const drogon::HttpResponsePtr root = sendGetTree(h.api, "", "t_a");
  const drogon::HttpResponsePtr rootGuides = sendGetGuides(h.api, "", "t_a");
  installWriteReporter(nullptr);

  const std::string absent{sendGetTree(h.api, "", "t_absent")->getBody()};
  CHECK_EQ(subtree->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(std::string(subtree->getBody()), absent);
  CHECK_EQ(guides->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(std::string(guides->getBody()), absent);
  CHECK_EQ(root->getStatusCode(), drogon::k200OK);
  CHECK_EQ(rootGuides->getStatusCode(), drogon::k200OK);
  const std::string failed = "roadmap.tree.place roadmap rest failed " + std::string(typeid(std::runtime_error).name());
  CHECK_EQ(failures->reports, (std::vector<std::string>{failed, failed}));
}

// A subtree is named by its owning step's label on the guides read too, its writer's and its readers' alike: its own
// title register, which the socket and a posted document still write, is read by nothing.
TEST(get_guides_names_a_subtree_by_its_owning_step_and_never_by_its_own_title_register) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedForest(owner, Visibility::unlisted);
  h.trees->byId["t_a"].guide = Lww<std::string>{"Plan the year.", Hlc{2, 0, "seed"}};
  h.trees->byId["t_s"].guide = Lww<std::string>{"Rig first.", Hlc{2, 0, "seed"}};
  h.trees->byId["t_s"].title = Lww<std::string>{"Its own register", Hlc{3, 0, "r_old"}};

  CHECK_EQ(bodyOf(sendGetGuides(h.api, "s-owner", "t_s")),
           parse(R"({"guides":[{"treeId":"t_a","title":"My year","text":"Plan the year.","yours":true},)"
                 R"({"treeId":"t_s","title":"Learn to sail","text":"Rig first.","yours":true}]})"));
  CHECK_EQ(bodyOf(sendGetGuides(h.api, "", "t_s")),
           parse(R"({"guides":[{"treeId":"t_s","title":"Learn to sail","text":"Rig first.","yours":false}]})"));
  CHECK_EQ(bodyOf(sendGetTree(h.api, "", "t_s"))["data"]["title"], Json::Value("Learn to sail"));
}

// A fork of a subtree is refused 409 `not-a-root`, naming where it hangs; a fork of its root copies the branch. While a
// stored deletion of an owning step hides the branch, every read of a tree in it — the tree, its guides, its
// diagnostics — answers the 404 an absent tree gets, to its owner and to a reader, and a fork aimed at it does too,
// with nothing of the hidden tree written.
TEST(a_hidden_branch_answers_every_rest_door_as_absent_and_a_subtree_is_forked_only_with_its_root) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-stranger", "stranger@example.com");
  h.seedForest(owner, Visibility::unlisted);

  const drogon::HttpResponsePtr refused = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-stranger"), "t_r");
  REQUIRE_EQ(refused->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(bodyOf(refused), parse(R"({"code":"not-a-root","parent":{"tree":"t_s","step":"rig"},"root":"t_a",)"
                                  R"("error":"this tree hangs from step \"rig\" of t_s under the root t_a: a subtree is )"
                                  R"(copied with its root, so fork the root"})"));
  const drogon::HttpResponsePtr forked = sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-stranger"), "t_a");
  REQUIRE_EQ(forked->getStatusCode(), drogon::k201Created);
  CHECK_EQ(h.trees->forks.back().size(), 3u);

  h.rooms->sweep(std::chrono::steady_clock::duration::zero());
  LooseGraph root(h.trees->byId["t_a"].state);
  root.deleteNode(NodeId{"sail"}, Hlc{50, 0, "web"});
  h.trees->byId["t_a"].state = root.exportState();
  for (const char* session : {"s-owner", "s-stranger", ""})
    for (const char* tree : {"t_s", "t_r"}) {
      CHECK_EQ(sendGetTree(h.api, session, tree)->getStatusCode(), drogon::k404NotFound);
      CHECK_EQ(sendGetGuides(h.api, session, tree)->getStatusCode(), drogon::k404NotFound);
      CHECK_EQ(sendGetDiagnostics(h.api, session, tree)->getStatusCode(), drogon::k404NotFound);
    }
  CHECK_EQ(sendFork(h.api, forkRequest(Json::Value(Json::objectValue), "s-owner"), "t_s")->getStatusCode(),
           drogon::k404NotFound);
  CHECK(LooseGraph(h.trees->byId["t_s"].state).presentNodeIds() == (std::vector<NodeId>{NodeId{"knot"}, NodeId{"rig"}}));
}

// The gate alone decides whether a branch stands. A revive whose save the store has not taken yet shows the branch to
// the gate at once, and every read past it answers the tree as it stands — its name, its place, its guides — while
// the stored rows still hold the step deleted.
TEST(a_revive_held_unsaved_shows_the_branch_to_every_read_past_the_gate) {
  Harness h;
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-reader", "reader@example.com");
  h.seedForest(owner, Visibility::unlisted);
  const auto onRoot = [&](const std::function<void(TreeRoom&)>& write) {
    std::lock_guard<std::mutex> strand(h.rooms->strandFor(TreeId{"t_a"}));
    write(*h.rooms->open(TreeId{"t_a"}));
    return h.rooms->persist(TreeId{"t_a"});
  };
  REQUIRE(onRoot([&](TreeRoom& room) {
            room.applyCommands({DeleteNode{NodeId{"sail"}}}, 50, owner, {TreeId{"t_s"}});
          }).wait() == Saved::saved);
  REQUIRE_EQ(sendGetTree(h.api, "s-owner", "t_r")->getStatusCode(), drogon::k404NotFound);

  h.trees->savesFail = true;
  REQUIRE(onRoot([&](TreeRoom& room) {
            room.applyCommand(CreateNode{NodeId{"sail"}, "Learn to sail", "", NodeColor::sky}, 60, owner);
          }).wait() == Saved::held);
  CHECK_FALSE(LooseGraph(h.trees->byId["t_a"].state).hasNode(NodeId{"sail"}));
  for (const char* session : {"s-owner", "s-reader"}) {
    const drogon::HttpResponsePtr read = sendGetTree(h.api, session, "t_r");
    REQUIRE_EQ(read->getStatusCode(), drogon::k200OK);
    CHECK_EQ((*read->getJsonObject())["data"]["title"].asString(), std::string("Rig the boat"));
    CHECK_EQ((*read->getJsonObject())["path"][0]["title"].asString(), std::string("My year"));
    CHECK_EQ(sendGetGuides(h.api, session, "t_s")->getStatusCode(), drogon::k200OK);
  }
}

// A read that opens the first room of a root's trees makes the root's live access; the read of the absent owning steps
// that fails there is the request's one Issue, under `roadmap.tree.standing`, and the read answers the 404 every failed
// read does.
TEST(a_read_whose_standing_read_fails_as_its_room_opens_files_one_issue_under_the_standing_read) {
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
  const UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedForest(owner, Visibility::unlisted);
  h.trees->absentReadsFail = true;
  CHECK_EQ(sendGetTree(h.api, "s-owner", "t_s")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(reporter.failures->reports,
           (std::vector<std::string>{std::string("roadmap.tree.standing roadmap rest failed ") +
                                     typeid(std::runtime_error).name()}));
  h.trees->absentReadsFail = false;
  CHECK_EQ(sendGetTree(h.api, "s-owner", "t_s")->getStatusCode(), drogon::k200OK);
}
