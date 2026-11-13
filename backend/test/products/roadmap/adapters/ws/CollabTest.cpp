#include "products/roadmap/adapters/ws/Collab.h"
#include "platform/adapters/mcp/CompositeToolHost.h"
#include "products/roadmap/adapters/mcp/RoadmapTools.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include "platform/application/WriteObservation.h"

#include <trantor/net/InetAddress.h>
#include <trantor/utils/Logger.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct FakeSocket : drogon::WebSocketConnection {
  std::vector<std::string> sent;
  bool open = true;
  trantor::InetAddress addr;

  void send(const char* msg, uint64_t len, const drogon::WebSocketMessageType) override {
    sent.emplace_back(msg, len);
  }
  void send(std::string_view msg, const drogon::WebSocketMessageType) override {
    sent.emplace_back(msg);
  }
  void sendJson(const Json::Value&, const drogon::WebSocketMessageType) override {}
  const trantor::InetAddress& localAddr() const override { return addr; }
  const trantor::InetAddress& peerAddr() const override { return addr; }
  bool connected() const override { return open; }
  bool disconnected() const override { return !open; }
  void shutdown(const drogon::CloseCode, const std::string&) override { open = false; }
  void forceClose() override { open = false; }
  void setPingMessage(const std::string&, const std::chrono::duration<double>&) override {}
  void disablePing() override {}
};

struct Harness {
  FakeProgressRepository progressRepo;
  FakeTreeRepository trees{progressRepo};
  FakeOpLog ops;
  WsPresenceBus bus;
  RoomRegistry rooms{trees, ops, bus};
  ProgressService progress{progressRepo, trees};
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  AuthService auth{authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works"};
  PresenceHub presence;
  NodeEdits edits{rooms, progress, bus, clock};
  TreeRegistry trees_registry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, rooms, edits, clock};
  Collab collab{rooms, ops, bus, progress, auth, presence, clock, {"https://windmill.works"}};

  UserId signIn(const std::string& secret, const std::string& emailAddr) {
    User user = authRepo.createUser(Email{emailAddr}, "sam");
    authRepo.insertSession(tokens.digestOf(secret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void addSession(const std::string& secret, const UserId& user) {
    authRepo.insertSession(tokens.digestOf(secret), user, clock.now + 1'000'000, "", "", clock.now);
  }

  void seed(const char* id, const UserId& owner, Visibility visibility) {
    trees.byId[id] = StoredTree{GraphState{}, LegendState{}, {"Tree", {}}, 0, owner, visibility};
  }

  // A tree of `idea` and `plain`, `idea` opening `opens` when one is named.
  void seedSteps(const char* id, const UserId& owner, Visibility visibility, const char* opens) {
    LooseGraph graph;
    graph.createNode(NodeId{"idea"}, "Idea", "", NodeColor::sky, std::nullopt, Hlc{100, 0, "r_seed"});
    graph.createNode(NodeId{"plain"}, "Plain", "", NodeColor::sky, std::nullopt, Hlc{101, 0, "r_seed"});
    graph.setOpens(NodeId{"idea"}, TreeId{opens}, Hlc{102, 0, "r_seed"});
    trees.byId[id] = StoredTree{graph.exportState(), LegendState{}, {"Tree", {}}, 0, owner, visibility};
  }

  drogon::HttpRequestPtr upgrade(const std::string& session, const std::string& origin = "") {
    auto req = drogon::HttpRequest::newHttpRequest();
    if (!session.empty()) req->addCookie("wm_session", session);
    if (!origin.empty()) req->addHeader("Origin", origin);
    return req;
  }
};

std::string subscribeFrame(const std::string& treeId) {
  Json::Value f(Json::objectValue);
  f["t"] = "subscribe";
  f["treeId"] = treeId;
  return dump(f);
}

std::string writeFrame(const std::string& treeId) {
  Json::Value f(Json::objectValue);
  f["t"] = "subgraph";
  f["treeId"] = treeId;
  f["frameId"] = "f1";
  return dump(f);
}

struct Mark {
  std::string node;
  std::string status;
  std::string at;
};

std::string progressFrame(const std::string& treeId, const std::string& frameId, const std::vector<Mark>& marks) {
  Json::Value f(Json::objectValue);
  f["t"] = "progress";
  f["treeId"] = treeId;
  f["frameId"] = frameId;
  Json::Value rows(Json::arrayValue);
  for (const Mark& mark : marks) {
    Json::Value row(Json::objectValue);
    row["node"] = mark.node;
    row["status"] = mark.status;
    row["at"] = mark.at;
    rows.append(row);
  }
  f["marks"] = rows;
  return dump(f);
}

// A subgraph frame carrying one node with the given description, as a client lattice would send
// it. The description is spliced in after serialization, so malformed bytes reach the door as the
// client sent them rather than as the JSON writer would rewrite them.
std::string nodeFrame(const std::string& treeId, const char* frameId, const std::string& description) {
  LooseGraph g;
  g.createNode(NodeId{"hull"}, "hull", "", NodeColor::sky, std::nullopt, Hlc{100, 0, "client"});
  g.setDescription(NodeId{"hull"}, "RAW", Hlc{101, 0, "client"});
  Json::Value f(Json::objectValue);
  f["t"] = "subgraph";
  f["treeId"] = treeId;
  f["frameId"] = frameId;
  f["nodes"] = toJson(g.exportState())["nodes"];
  std::string text = dump(f);
  text.replace(text.find("RAW"), 3, description);
  return text;
}

// A subgraph frame whose one node entry carries exactly the registers given, as a client lattice sends a write.
std::string registerFrame(const std::string& treeId, const char* frameId, const std::string& node) {
  Json::Value f(Json::objectValue);
  f["t"] = "subgraph";
  f["treeId"] = treeId;
  f["frameId"] = frameId;
  f["nodes"].append(parse(node));
  return dump(f);
}

// A subgraph frame carrying only the tree's guide register, as a client lattice would send it.
std::string guideFrame(const std::string& treeId, const char* frameId, const std::string& guide, const std::string& at) {
  Json::Value written(Json::objectValue);
  written["v"] = guide;
  written["at"] = at;
  Json::Value f(Json::objectValue);
  f["t"] = "subgraph";
  f["treeId"] = treeId;
  f["frameId"] = frameId;
  f["guide"] = written;
  return dump(f);
}

// What a test's writes leave behind while it is in scope: their completions, the Issues they file
// (operation and exception type, the only fields a report carries) and every log line.
struct Observed : FailureReporter {
  std::mutex mutex;
  std::vector<WriteCompletion> completions;
  std::vector<std::string> issues;
  std::vector<std::string> lines;
  trantor::Logger::LogLevel level = trantor::Logger::logLevel();
  Observed() {
    installWriteSink([this](const WriteCompletion& completion) {
      std::lock_guard lock(mutex);
      completions.push_back(completion);
    });
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
    trantor::Logger::setLogLevel(trantor::Logger::kTrace);
    trantor::Logger::setOutputFunction(
        [this](const char* message, std::uint64_t length) {
          std::lock_guard lock(mutex);
          lines.emplace_back(message, length);
        },
        [] {});
  }
  ~Observed() override {
    installWriteSink({});
    installWriteReporter({});
    trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                       [] { fflush(stdout); });
    trantor::Logger::setLogLevel(level);
  }
  void report(const std::string&, const std::string& where, const std::string&) override {
    std::lock_guard lock(mutex);
    issues.push_back(where);
  }
  void reportWrite(const std::string& operation, const std::string&, const std::string&, const std::string&,
                   const std::string&, const std::string&) override {
    std::lock_guard lock(mutex);
    issues.push_back(operation);
  }
};

std::string rejectReason(const std::string& text) { return parse(text).get("reason", "").asString(); }
std::string rejectCode(const std::string& text) { return parse(text).get("code", "").asString(); }

void broadcastTo(WsPresenceBus& bus, const char* tree) {
  Subgraph frame;
  frame.treeId = TreeId{tree};
  bus.broadcastSubgraph(TreeId{tree}, 2, frame);
}

std::string frameType(const std::string& text) { return parse(text).get("t", "").asString(); }

std::size_t countOfType(const FakeSocket& conn, const std::string& type) {
  std::size_t seen = 0;
  for (const std::string& text : conn.sent) if (frameType(text) == type) ++seen;
  return seen;
}

Json::Value lastFrameOfType(const FakeSocket& conn, const std::string& type) {
  for (auto it = conn.sent.rbegin(); it != conn.sent.rend(); ++it)
    if (frameType(*it) == type) return parse(*it);
  return Json::Value(Json::objectValue);
}

std::string announcedActor(const FakeSocket& conn) {
  for (auto it = conn.sent.rbegin(); it != conn.sent.rend(); ++it) {
    Json::Value frame = parse(*it);
    if (frame.get("t", "").asString() == "peer" && frame.get("event", "").asString() == "join")
      return frame.get("actor", "").asString();
  }
  return "";
}

std::string announcedName(const FakeSocket& conn) {
  for (auto it = conn.sent.rbegin(); it != conn.sent.rend(); ++it) {
    Json::Value frame = parse(*it);
    if (frame.get("t", "").asString() == "peer" && frame.get("event", "").asString() == "join")
      return frame["profile"].get("name", "").asString();
  }
  return "";
}

}

TEST(ws_owner_of_a_private_tree_subscribes_and_receives_the_delta) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(countOfType(*conn, "subgraph"), 1u);
  CHECK_EQ(countOfType(*conn, "reject"), 0u);
  CHECK_EQ(countOfType(*conn, "progress"), 1u);

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(countOfType(*conn, "subgraph"), 2u);
}

TEST(ws_anon_on_a_private_tree_is_rejected_and_never_joins_the_bus) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(parse(conn->sent[0])["treeId"].asString(), std::string("t_priv"));

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), 1u);
}

TEST(ws_non_owner_on_a_private_tree_is_rejected_and_never_joins_the_bus) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), 1u);
}

TEST(ws_anon_on_an_unlisted_tree_receives_the_delta_and_joins_the_bus) {
  Harness h;
  h.seed("t_shared", UserId{"owner"}, Visibility::unlisted);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_shared"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_FALSE(frameType(conn->sent[0]) == "reject");

  broadcastTo(h.bus, "t_shared");
  CHECK_EQ(conn->sent.size(), 2u);
}

TEST(ws_the_subscribe_answer_says_writer_to_the_owner_and_reader_to_anyone_else_and_says_it_again_on_a_resubscribe) {
  for (const Visibility visibility : {Visibility::public_, Visibility::unlisted}) {
    Harness h;
    UserId owner = h.signIn("s-owner", "owner@example.com");
    h.signIn("s-stranger", "stranger@example.com");
    h.seed("t_door", owner, visibility);
    auto laptop = std::make_shared<FakeSocket>();
    auto stranger = std::make_shared<FakeSocket>();
    auto signedOut = std::make_shared<FakeSocket>();
    h.collab.onOpen(h.upgrade("s-owner"), laptop);
    h.collab.onOpen(h.upgrade("s-stranger"), stranger);
    h.collab.onOpen(h.upgrade(""), signedOut);
    h.collab.onMessage(laptop, registerFrame("t_door", "f-create",
                                             R"({"id":"door","createdAt":"1000:0:r_a","opens":"t_00000000000000f2","opensAt":"1000:0:r_a"})"));
    NodeStateEntry withheld;
    withheld.id = NodeId{"door"};
    withheld.createdAt = Hlc{1000, 0, "r_a"};
    NodeStateEntry whole = withheld;
    whole.opens = TreeId{"t_00000000000000f2"};
    whole.opensAt = Hlc{1000, 0, "r_a"};
    const auto answer = [](const NodeStateEntry& door, const char* reach) {
      Json::Value frame = parse(R"({"t":"subgraph","v":1,"treeId":"t_door","frameId":"delta-1","actor":"srv","intent":"delta",
                                    "edges":[],"kinds":[],"gestures":[],"title":null,"guide":null,
                                    "coverage":{"r_a":"1000:0:r_a"},"seq":1})");
      frame["nodes"] = toJson(GraphState{{door}, {}})["nodes"];
      frame["reach"] = reach;
      return frame;
    };

    for (const auto& conn : {laptop, stranger, signedOut}) h.collab.onMessage(conn, subscribeFrame("t_door"));
    CHECK_EQ(lastFrameOfType(*laptop, "subgraph"), answer(whole, "writer"));
    CHECK_EQ(lastFrameOfType(*stranger, "subgraph"), answer(withheld, "reader"));
    CHECK_EQ(lastFrameOfType(*signedOut, "subgraph"), answer(withheld, "reader"));

    for (const auto& conn : {laptop, stranger, signedOut}) h.collab.onMessage(conn, subscribeFrame("t_door"));
    for (const auto& conn : {laptop, stranger, signedOut}) REQUIRE_EQ(countOfType(*conn, "subgraph"), 2u);
    CHECK_EQ(lastFrameOfType(*laptop, "subgraph"), answer(whole, "writer"));
    CHECK_EQ(lastFrameOfType(*stranger, "subgraph"), answer(withheld, "reader"));
    CHECK_EQ(lastFrameOfType(*signedOut, "subgraph"), answer(withheld, "reader"));
  }
}

TEST(ws_subscribe_to_an_absent_tree_is_rejected) {
  Harness h;
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_ghost"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
}

TEST(ws_write_to_a_private_tree_you_dont_own_reads_as_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto onPrivate = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), onPrivate);
  h.collab.onMessage(onPrivate, writeFrame("t_priv"));

  auto onAbsent = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), onAbsent);
  h.collab.onMessage(onAbsent, writeFrame("t_ghost"));

  REQUIRE_EQ(onPrivate->sent.size(), 1u);
  CHECK_EQ(frameType(onPrivate->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(onPrivate->sent[0]), std::string("no such tree \"t_priv\""));
  CHECK_EQ(rejectReason(onAbsent->sent[0]), std::string("no such tree \"t_ghost\""));
  CHECK_EQ(rejectCode(onPrivate->sent[0]), std::string("no-such-tree"));
  CHECK_EQ(rejectCode(onAbsent->sent[0]), std::string("no-such-tree"));
}

TEST(ws_write_to_an_unlisted_tree_you_dont_own_says_it_belongs_to_another) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_shared", UserId{"owner"}, Visibility::unlisted);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, writeFrame("t_shared"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("this tree belongs to another account"));
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("not-yours"));
}

TEST(ws_write_to_an_unowned_private_tree_reads_as_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.trees.byId["t_orphan"] = StoredTree{GraphState{}, LegendState{}, {"Tree", {}}, 0, std::nullopt, Visibility::private_};

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, writeFrame("t_orphan"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("no such tree \"t_orphan\""));
}

TEST(ws_write_to_an_unowned_public_tree_is_refused_and_never_claims_it) {
  Harness h;
  h.signIn("s-visitor", "visitor@example.com");
  h.trees.byId["t_demo"] =
      StoredTree{GraphState{}, LegendState{}, {"Learn to sail", {}}, 0, std::nullopt, Visibility::public_};
  const StoredTree before = h.trees.byId["t_demo"];

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-visitor"), conn);
  h.collab.onMessage(conn, writeFrame("t_demo"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(conn->sent[0]),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, "
                       "or fork it into a roadmap of your own"));
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("nobodys-tree"));
  CHECK_FALSE(h.trees.byId["t_demo"].owner.has_value());
  CHECK(h.trees.byId["t_demo"] == before);
  CHECK(h.ops.byTree["t_demo"].empty());

  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_demo"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  CHECK_FALSE(frameType(reader->sent[0]) == "reject");
}

TEST(ws_guest_write_is_turned_away_at_auth_before_the_tree_is_looked_up) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto onReal = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), onReal);
  h.collab.onMessage(onReal, writeFrame("t_priv"));

  auto onAbsent = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), onAbsent);
  h.collab.onMessage(onAbsent, writeFrame("t_ghost"));

  CHECK_EQ(rejectReason(onReal->sent[0]), std::string("sign in to edit"));
  CHECK_EQ(rejectReason(onAbsent->sent[0]), std::string("sign in to edit"));
  CHECK_EQ(rejectCode(onReal->sent[0]), std::string("sign-in-required"));
  CHECK_EQ(rejectCode(onAbsent->sent[0]), std::string("sign-in-required"));
}

TEST(ws_guest_progress_is_rejected_with_the_sign_in_code_and_the_frame_named) {
  Harness h;
  h.seed("t_open", UserId{"owner"}, Visibility::unlisted);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);

  h.collab.onMessage(conn, progressFrame("t_open", "f1", {{"root", "complete", "500:0:r_a"}}));

  REQUIRE_EQ(conn->sent.size(), 1u);
  Json::Value reject = parse(conn->sent[0]);
  CHECK_EQ(reject["t"].asString(), std::string("reject"));
  CHECK_EQ(reject["code"].asString(), std::string("sign-in-required"));
  CHECK_EQ(reject["reason"].asString(), std::string("sign in to track progress"));
  CHECK_EQ(reject["frameId"].asString(), std::string("f1"));
  CHECK_FALSE(reject.isMember("nodeId"));
}

TEST(ws_progress_records_the_clients_own_stamps_and_acks_the_frame) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f7",
                                         {{"root", "complete", "900:0:r_phone"}, {"b", "active", "901:0:r_phone"}}));

  Progress stored = h.progressRepo.load(TreeId{"t_priv"}, owner);
  REQUIRE_EQ(stored.marks.size(), 2u);
  CHECK_EQ(stored.marks.at(NodeId{"root"}).at, (Hlc{900, 0, "r_phone"}));
  CHECK(stored.marks.at(NodeId{"root"}).status == ProgressStatus::complete);
  CHECK(stored.marks.at(NodeId{"b"}).status == ProgressStatus::none);
  CHECK_EQ(lastFrameOfType(*conn, "progressAck")["frameId"].asString(), std::string("f7"));
}

TEST(ws_progress_echoes_the_registers_with_both_clocks) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", "900:0:r_phone"}}));

  Json::Value echo = lastFrameOfType(*conn, "progress");
  REQUIRE_EQ(echo["marks"].size(), 1u);
  CHECK_EQ(echo["marks"][0]["node"].asString(), std::string("root"));
  CHECK_EQ(echo["marks"][0]["at"].asString(), std::string("900:0:r_phone"));
  CHECK_EQ(echo["marks"][0]["markedAt"].asUInt64(), h.clock.nowMs());
}

TEST(ws_progress_never_reaches_another_account_on_the_same_tree) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-other", "other@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto stranger = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), stranger);
  h.collab.onMessage(stranger, subscribeFrame("t_pub"));
  auto mine = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), mine);
  h.collab.onMessage(mine, subscribeFrame("t_pub"));
  stranger->sent.clear();

  h.collab.onMessage(mine, progressFrame("t_pub", "f1", {{"root", "complete", "900:0:r_a"}}));

  for (const std::string& text : stranger->sent) CHECK(frameType(text) != std::string("progress"));
}

TEST(ws_progress_refuses_a_frame_whose_mark_carries_no_stamp) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", ""}}));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK(h.progressRepo.load(TreeId{"t_priv"}, owner).marks.empty());
}

TEST(ws_progress_refuses_a_malformed_stamp_instead_of_throwing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", "not-a-number:0:r_a"}}));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
}

TEST(ws_progress_clamps_a_stamp_from_the_far_future) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  conn->sent.clear();

  const std::string runaway = std::to_string(h.clock.nowMs() + 6 * 60 * 1000) + ":0:r_a";
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", runaway}}));

  REQUIRE_EQ(conn->sent.size(), 1u);
  Json::Value skew = parse(conn->sent[0]);
  CHECK_EQ(skew["t"].asString(), std::string("skew"));
  CHECK_EQ(skew["frameId"].asString(), std::string("f1"));
  CHECK_EQ(skew["serverNow"].asUInt64(), h.clock.nowMs());
  CHECK(h.progressRepo.load(TreeId{"t_priv"}, owner).marks.empty());
}

TEST(ws_progress_is_last_writer_wins_so_a_late_older_mark_loses) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", "900:0:r_desk"}}));
  h.collab.onMessage(conn, progressFrame("t_priv", "f2", {{"root", "none", "500:0:r_phone"}}));

  Progress stored = h.progressRepo.load(TreeId{"t_priv"}, owner);
  CHECK(stored.marks.at(NodeId{"root"}).status == ProgressStatus::complete);
  CHECK_EQ(stored.marks.at(NodeId{"root"}).at, (Hlc{900, 0, "r_desk"}));
}

TEST(ws_subscribe_grafts_the_callers_overlay_alongside_the_structure) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  h.progressRepo.setStatus(TreeId{"t_priv"}, owner, NodeId{"root"}, ProgressStatus::complete, false, Hlc{900, 0, "r_elsewhere"}, 900);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  Json::Value graft = lastFrameOfType(*conn, "progress");
  REQUIRE_EQ(graft["marks"].size(), 1u);
  CHECK_EQ(graft["marks"][0]["node"].asString(), std::string("root"));
  CHECK_EQ(graft["marks"][0]["at"].asString(), std::string("900:0:r_elsewhere"));
}

TEST(ws_subscribe_grafts_no_overlay_to_an_anonymous_visitor) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);
  h.progressRepo.setStatus(TreeId{"t_pub"}, owner, NodeId{"root"}, ProgressStatus::complete, false, Hlc{900, 0, "r_a"}, 900);

  auto visitor = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), visitor);
  h.collab.onMessage(visitor, subscribeFrame("t_pub"));

  for (const std::string& text : visitor->sent) CHECK(frameType(text) != std::string("progress"));
}

TEST(ws_progress_does_not_echo_a_mark_that_lost_to_a_later_stamp) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", "900:0:r_desk"}}));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f2", {{"root", "none", "500:0:r_stale"}}));

  CHECK_EQ(countOfType(*conn, "progress"), 0u);
  CHECK_EQ(lastFrameOfType(*conn, "progressAck")["frameId"].asString(), std::string("f2"));
  CHECK(h.progressRepo.load(TreeId{"t_priv"}, owner).marks.at(NodeId{"root"}).status == ProgressStatus::complete);
}

TEST(ws_progress_echoes_the_landed_half_of_a_mixed_batch) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"kept", "complete", "900:0:r_desk"}}));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f2",
                                         {{"kept", "none", "500:0:r_stale"}, {"fresh", "inProgress", "950:0:r_stale"}}));

  Json::Value echo = lastFrameOfType(*conn, "progress");
  REQUIRE_EQ(echo["marks"].size(), 1u);
  CHECK_EQ(echo["marks"][0]["node"].asString(), std::string("fresh"));
  CHECK_EQ(echo["marks"][0]["status"].asString(), std::string("none"));
}

TEST(ws_progress_refuses_a_batch_past_the_frame_ceiling) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  conn->sent.clear();

  std::vector<Mark> huge;
  for (int i = 0; i < 2001; ++i) huge.push_back({"n" + std::to_string(i), "complete", "900:0:r_a"});
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", huge));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("tree-too-large"));
  CHECK(h.progressRepo.load(TreeId{"t_priv"}, owner).marks.empty());
}

TEST(ws_owner_writes_to_their_own_private_tree_and_is_acked) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, writeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
}

TEST(presence_announces_an_account_by_the_name_it_chose) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");  // signIn names the account "sam"
  h.seed("t_pub", owner, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  auto named = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), named);
  h.collab.onMessage(named, subscribeFrame("t_pub"));

  CHECK_EQ(announcedName(*watcher), std::string("sam"));
}

TEST(presence_never_announces_a_name_still_spliced_from_an_address) {
  Harness h;
  User plain = h.authRepo.createUser(Email{"sam.gold@example.com"}, "sam.gold");
  h.authRepo.insertSession(h.tokens.digestOf("s-plain"), plain.id, h.clock.now + 1'000'000, "", "", h.clock.now);
  h.seed("t_pub", plain.id, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  auto derived = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-plain"), derived);
  h.collab.onMessage(derived, subscribeFrame("t_pub"));

  const std::string announced = announcedName(*watcher);
  CHECK_FALSE(announced == std::string("sam.gold"));
  CHECK_FALSE(announced.empty());
  CHECK(announced.find(' ') != std::string::npos);
}

TEST(presence_does_not_reannounce_a_connection_that_resubscribes) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  auto guest = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), guest);
  h.collab.onMessage(guest, subscribeFrame("t_pub"));
  const std::string announced = announcedName(*watcher);
  const std::size_t seen = watcher->sent.size();
  const std::size_t guestSeen = guest->sent.size();

  h.collab.onMessage(guest, subscribeFrame("t_pub"));
  CHECK_EQ(watcher->sent.size(), seen);
  CHECK_EQ(announcedName(*watcher), announced);
  CHECK_EQ(guest->sent.size(), guestSeen + 1);
}

TEST(presence_never_seats_two_guests_under_one_name) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  std::set<std::string> names;
  std::vector<std::shared_ptr<FakeSocket>> guests;
  for (int i = 0; i < 40; ++i) {
    auto guest = std::make_shared<FakeSocket>();
    h.collab.onOpen(h.upgrade(""), guest);
    h.collab.onMessage(guest, subscribeFrame("t_pub"));
    names.insert(announcedName(*watcher));
    guests.push_back(guest);
  }
  CHECK_EQ(names.size(), 40u);
}

TEST(presence_gives_a_guest_a_travellers_name_not_a_row_number) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  auto guest = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), guest);
  h.collab.onMessage(guest, subscribeFrame("t_pub"));

  const std::string announced = announcedName(*watcher);
  CHECK_FALSE(announced.rfind("Guest", 0) == 0);
  CHECK(announced.find(' ') != std::string::npos);
  CHECK(announced.find_first_of("0123456789") == std::string::npos);
}

TEST(ws_a_frame_past_the_node_ceiling_is_rejected_by_code_and_joins_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-big";
  GraphState state;
  for (std::size_t i = 0; i <= kMaxNodes; ++i) {
    NodeStateEntry node;
    node.id = NodeId{"n" + std::to_string(i)};
    node.createdAt = Hlc{100, static_cast<std::uint32_t>(i), "client"};
    state.nodes.push_back(std::move(node));
  }
  frame["nodes"] = toJson(state)["nodes"];  // the wire carries nodes/edges at the top level

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("tree-too-large"));
  CHECK_EQ(rejectReason(conn->sent[0]),
           std::string("this tree would hold 10001 nodes, max 10000 — split it across roadmaps, "
                       "or delete what it has outgrown"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-big"));
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->exportState().nodes.size(), std::size_t{0});
}

TEST(ws_an_ordinary_frame_still_joins_and_acks_with_its_seq) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-one";
  GraphState state;
  NodeStateEntry node;
  node.id = NodeId{"hull"};
  node.label = "Hull";
  node.createdAt = Hlc{100, 0, "client"};
  node.labelAt = Hlc{100, 0, "client"};
  state.nodes.push_back(std::move(node));
  frame["nodes"] = toJson(state)["nodes"];

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
  CHECK_EQ(parse(conn->sent[0])["seq"].asInt64(), 1);
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->snapshot().nodes.size(), std::size_t{1});
}

TEST(ws_a_frame_past_the_legend_ceiling_is_rejected_and_joins_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  LegendState legend;
  for (int i = 0; i < 200; ++i) {
    KindStateEntry kind;
    kind.id = KindId{"k" + std::to_string(i)};
    kind.createdAt = Hlc{100, static_cast<std::uint32_t>(i), "client"};
    legend.kinds.push_back(std::move(kind));
  }
  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-kinds";
  frame["kinds"] = toJson(legend);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("tree-too-large"));
  CHECK_EQ(rejectReason(conn->sent[0]),
           std::string("this legend would hold 200 kinds, max 6 — remove a kind before adding another"));
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->exportLegend().kinds.size(), std::size_t{0});
}

// A kind has no cross-branch flag: a frame whose kind entry still carries one, with its stamp, lands as one that does
// not, and the legend the room then holds answers neither.
TEST(ws_a_frame_whose_kind_still_carries_a_cross_branch_flag_lands_without_it) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-flag";
  frame["kinds"] = parse(R"([{"id":"drill","createdAt":"100:0:client","deletedAt":"","hue":"gold","hueAt":"100:0:client",
    "label":"Drill","labelAt":"100:0:client","description":"","descriptionAt":"","crossBranchExempt":true,
    "crossBranchExemptAt":"101:0:client","rank":1.0,"rankAt":"100:0:client"}])");

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(toJson(h.rooms.open(TreeId{"t_priv"})->exportLegend()),
           parse(R"([{"id":"drill","createdAt":"100:0:client","deletedAt":"0:0:","hue":"gold","hueAt":"100:0:client",
             "label":"Drill","labelAt":"100:0:client","description":"","descriptionAt":"0:0:","rank":1.0,
             "rankAt":"100:0:client"}])"));
}

TEST(ws_a_frame_with_an_oversized_title_is_rejected_and_joins_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  Json::Value title(Json::objectValue);
  title["v"] = std::string(40000, 'x');
  title["at"] = "100:0:client";
  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-title";
  frame["title"] = title;

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("the title would be 40000 characters, 39800 over the 200 cap"));
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->title().value, std::string("Tree"));
}

TEST(ws_a_malformed_field_is_rejected_as_bad_frame_not_as_a_full_tree) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  GraphState state;
  NodeStateEntry node;
  node.id = NodeId{std::string(kMaxIdLength + 1, 'x')};
  node.createdAt = Hlc{100, 0, "client"};
  state.nodes.push_back(std::move(node));
  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-bad";
  frame["nodes"] = toJson(state)["nodes"];

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("a node id would be 129 characters, 1 over the 128 cap"));
}

TEST(ws_a_visibility_flip_drops_the_reader_it_locks_out) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_pub"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(reader->sent.size(), 2u);

  {
    std::lock_guard<std::mutex> strand(h.rooms.strandFor(TreeId{"t_pub"}));
    h.rooms.setVisibility(TreeId{"t_pub"}, Visibility::private_);
  }
  REQUIRE_EQ(reader->sent.size(), 3u);
  CHECK_EQ(frameType(reader->sent[2]), std::string("reject"));
  CHECK_EQ(rejectCode(reader->sent[2]), std::string("no-such-tree"));
  CHECK_EQ(rejectReason(reader->sent[2]), std::string("no such tree \"t_pub\""));

  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(reader->sent.size(), 3u);
}

TEST(ws_a_visibility_flip_keeps_the_owner_reading) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_pub"));
  REQUIRE_EQ(countOfType(*conn, "subgraph"), 1u);

  {
    std::lock_guard<std::mutex> strand(h.rooms.strandFor(TreeId{"t_pub"}));
    h.rooms.setVisibility(TreeId{"t_pub"}, Visibility::private_);
  }
  CHECK_EQ(countOfType(*conn, "reject"), 0u);

  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(countOfType(*conn, "subgraph"), 2u);
}

TEST(ws_a_revoked_session_stops_receiving_the_tree_it_was_reading) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  REQUIRE_EQ(countOfType(*conn, "subgraph"), 1u);
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(countOfType(*conn, "subgraph"), 2u);

  h.authRepo.deleteSession(h.tokens.digestOf("s-owner"));
  h.collab.reproveReaders();
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(countOfType(*conn, "subgraph"), 3u);

  h.clock.now += 61'000;  // past the one-minute re-proof
  h.collab.reproveReaders();
  REQUIRE_EQ(countOfType(*conn, "reject"), 1u);
  CHECK_EQ(rejectCode(conn->sent.back()), std::string("no-such-tree"));

  const std::size_t afterRefusal = conn->sent.size();
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), afterRefusal);
}

TEST(ws_presence_never_puts_the_account_id_on_the_wire) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto stranger = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), stranger);
  h.collab.onMessage(stranger, subscribeFrame("t_pub"));

  auto member = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), member);
  h.collab.onMessage(member, subscribeFrame("t_pub"));

  const std::string actor = announcedActor(*stranger);
  CHECK_FALSE(actor == owner.str());
  CHECK_EQ(actor, std::string("p2"));
  CHECK_EQ(announcedName(*stranger), std::string("sam"));

  Json::Value cursor(Json::objectValue);
  cursor["t"] = "presence";
  cursor["treeId"] = "t_pub";
  cursor["cursor"] = Json::Value(Json::objectValue);
  cursor["cursor"]["x"] = 4.0;
  cursor["cursor"]["y"] = 2.0;
  h.collab.onMessage(member, dump(cursor));
  h.presence.flush();

  bool sawCursor = false;
  for (const std::string& text : stranger->sent) {
    Json::Value frame = parse(text);
    if (frame.get("t", "").asString() != "presence") continue;
    sawCursor = true;
    CHECK_EQ(frame.get("actor", "").asString(), std::string("p2"));
  }
  CHECK(sawCursor);
}

TEST(ws_a_denied_subscribe_materializes_no_room) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("no-such-tree"));
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.openRooms(), std::size_t{0});
}

TEST(ws_a_refused_write_materializes_no_room) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, writeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("no-such-tree"));
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_priv"}));
}

TEST(ws_an_upgrade_from_an_unlisted_origin_is_refused) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto evil = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner", "http://evil.example.com"), evil);
  CHECK_FALSE(evil->connected());

  h.collab.onMessage(evil, subscribeFrame("t_priv"));
  CHECK_EQ(evil->sent.size(), 0u);
}

TEST(ws_an_upgrade_from_the_app_or_from_no_origin_at_all_is_served) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto browser = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner", "https://windmill.works"), browser);
  h.collab.onMessage(browser, subscribeFrame("t_priv"));
  REQUIRE_EQ(countOfType(*browser, "subgraph"), 1u);
  CHECK_EQ(countOfType(*browser, "reject"), 0u);

  auto script = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), script);
  h.collab.onMessage(script, subscribeFrame("t_priv"));
  REQUIRE(script->sent.size() >= 1u);
  for (const std::string& text : script->sent) CHECK_FALSE(frameType(text) == "reject");
  CHECK(std::any_of(script->sent.begin(), script->sent.end(),
                    [](const std::string& text) { return frameType(text) == "subgraph"; }));
}

TEST(ws_a_frame_with_an_unreadable_stamp_is_refused_rather_than_dropped) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  Json::Value node(Json::objectValue);
  node["id"] = "n1";
  node["createdAt"] = "9999999999999999999999:0:a";
  Json::Value frame(Json::objectValue);
  frame["t"] = "subgraph";
  frame["treeId"] = "t_priv";
  frame["frameId"] = "f-huge";
  frame["nodes"] = Json::Value(Json::arrayValue);
  frame["nodes"].append(node);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("this frame could not be read"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-huge"));
}

TEST(ws_a_subscribe_with_an_unreadable_vector_is_refused_rather_than_dropped) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  Json::Value frame(Json::objectValue);
  frame["t"] = "subscribe";
  frame["treeId"] = "t_priv";
  frame["vector"] = Json::Value(Json::objectValue);
  frame["vector"]["a"] = "9999999999999999999999:0:a";

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("this frame could not be read"));
}

TEST(ws_presence_stops_reaching_a_revoked_reader_on_a_tree_nobody_is_editing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-owner-2", owner);
  h.seed("t_priv", owner, Visibility::private_);

  auto tab1 = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), tab1);
  h.collab.onMessage(tab1, subscribeFrame("t_priv"));
  auto tab2 = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner-2"), tab2);
  h.collab.onMessage(tab2, subscribeFrame("t_priv"));

  Json::Value cursor(Json::objectValue);
  cursor["t"] = "presence";
  cursor["treeId"] = "t_priv";
  cursor["cursor"] = Json::Value(Json::objectValue);
  cursor["cursor"]["x"] = 1.0;
  cursor["cursor"]["y"] = 2.0;
  cursor["selection"] = "a-private-node-id";
  h.collab.onMessage(tab1, dump(cursor));
  h.presence.flush();
  const auto presenceFrames = [](const FakeSocket& conn) {
    std::size_t seen = 0;
    for (const std::string& text : conn.sent) if (frameType(text) == "presence") ++seen;
    return seen;
  };
  REQUIRE_EQ(presenceFrames(*tab2), std::size_t{1});

  h.authRepo.deleteSession(h.tokens.digestOf("s-owner-2"));
  h.clock.now += 61'000;
  h.collab.reproveReaders();

  const std::size_t before = presenceFrames(*tab2);
  h.collab.onMessage(tab1, dump(cursor));
  h.presence.flush();
  CHECK_EQ(presenceFrames(*tab2), before);
  CHECK(std::any_of(tab2->sent.begin(), tab2->sent.end(),
                    [](const std::string& text) { return frameType(text) == "reject"; }));
  CHECK(std::any_of(tab1->sent.begin(), tab1->sent.end(), [](const std::string& text) {
    return frameType(text) == "peer" && parse(text).get("event", "").asString() == "leave";
  }));
}

TEST(ws_deleting_a_tree_drops_its_readers_and_refuses_a_fresh_one) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_pub"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  CHECK_FALSE(frameType(reader->sent[0]) == "reject");
  CHECK(h.rooms.isOpen(TreeId{"t_pub"}));

  CHECK(h.trees_registry.remove(TreeId{"t_pub"}, owner) == (std::variant<Cascade, TreeRegistry::RemovalRefusal>{Cascade{}}));

  REQUIRE_EQ(reader->sent.size(), 2u);
  CHECK_EQ(rejectCode(reader->sent[1]), std::string("no-such-tree"));
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_pub"}));

  auto fresh = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), fresh);
  h.collab.onMessage(fresh, subscribeFrame("t_pub"));
  REQUIRE_EQ(fresh->sent.size(), 1u);
  CHECK_EQ(frameType(fresh->sent[0]), std::string("reject"));
  CHECK_EQ(rejectCode(fresh->sent[0]), std::string("no-such-tree"));

  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(reader->sent.size(), 2u);
  CHECK_EQ(fresh->sent.size(), 1u);
}

TEST(ws_a_frame_carrying_invalid_utf8_is_rejected_by_name_before_it_touches_the_room) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.collab.onMessage(conn, nodeFrame("t_priv", "f-bad", std::string(100000, '\x80')));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("node \"hull\": description is not valid UTF-8"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-bad"));
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(0));
  CHECK(h.trees.byId["t_priv"].state.nodes.empty());

  h.collab.onMessage(conn, nodeFrame("t_priv", "f-ok", "\xE5\xAD\x97 \xF0\x9F\x98\x80"));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(1));
}

// The ack attests the save, and the save happened: a row that fails to land after it is logged and
// the frame is still acked, so the client does not re-flush a write the tree already holds.
TEST(ws_a_write_whose_op_row_fails_to_land_is_still_acked_and_the_row_lands_next_time) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.ops.failNextAppends = 1;
  h.collab.onMessage(conn, nodeFrame("t_priv", "f1", "body"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f1"));
  CHECK_EQ(parse(conn->sent[0])["seq"].asInt64(), 1);
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(1));
  CHECK(h.ops.byTree["t_priv"].empty());

  h.collab.onMessage(conn, nodeFrame("t_priv", "f2", "more"));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  REQUIRE_EQ(h.ops.byTree["t_priv"].size(), 2u);
  CHECK_EQ(h.ops.byTree["t_priv"][0].seq, static_cast<Seq>(1));
  CHECK_EQ(h.ops.byTree["t_priv"][1].seq, static_cast<Seq>(2));
}

TEST(ws_concurrent_guide_frames_converge_on_the_later_stamp_and_a_fresh_subscriber_receives_it) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-tablet", owner);
  h.seed("t_priv", owner, Visibility::private_);
  auto laptop = std::make_shared<FakeSocket>();
  auto tablet = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), laptop);
  h.collab.onOpen(h.upgrade("s-tablet"), tablet);

  h.collab.onMessage(tablet, guideFrame("t_priv", "f-tablet", "Start with the sails.", "2000:0:r_b"));
  h.collab.onMessage(laptop, guideFrame("t_priv", "f-laptop", "Start with the hull.", "2000:0:r_a"));
  CHECK_EQ(frameType(laptop->sent.back()), std::string("subgraphAck"));
  CHECK_EQ(frameType(tablet->sent.back()), std::string("subgraphAck"));
  const Lww<std::string> winner{"Start with the sails.", Hlc{2000, 0, "r_b"}};
  CHECK(h.trees.byId["t_priv"].guide == winner);
  CHECK(h.ops.byTree.empty());

  auto fresh = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), fresh);
  h.collab.onMessage(fresh, subscribeFrame("t_priv"));
  const Json::Value delta = lastFrameOfType(*fresh, "subgraph");
  CHECK_EQ(dump(delta["guide"]), std::string(R"({"at":"2000:0:r_b","v":"Start with the sails."})"));
  CHECK_EQ(delta["coverage"]["r_b"].asString(), std::string("2000:0:r_b"));
  CHECK(delta["title"].isNull());

  Json::Value caughtUp(Json::objectValue);
  caughtUp["t"] = "subscribe";
  caughtUp["treeId"] = "t_priv";
  caughtUp["vector"]["r_b"] = "2000:0:r_b";
  auto returning = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), returning);
  h.collab.onMessage(returning, dump(caughtUp));
  CHECK(lastFrameOfType(*returning, "subgraph")["guide"].isNull());
}

TEST(ws_a_frame_with_a_guide_past_five_thousand_characters_is_rejected_and_one_at_the_cap_lands) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  std::string grins;  // 5000 four-byte code points: 20000 bytes
  for (std::size_t i = 0; i < kMaxGuideChars; ++i) grins += "\xF0\x9F\x98\x80";

  h.collab.onMessage(conn, guideFrame("t_priv", "f-over", grins + "x", "100:0:client"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("the guide would be 5001 characters, 1 over the 5000 cap"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-over"));
  CHECK(h.trees.byId["t_priv"].guide == Lww<std::string>{});

  h.collab.onMessage(conn, guideFrame("t_priv", "f-cap", grins, "100:0:client"));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  CHECK(h.trees.byId["t_priv"].guide == (Lww<std::string>{grins, Hlc{100, 0, "client"}}));
}

// The sender stamped the text it holds, so a frame's guide of only whitespace cannot be stored as "":
// it is refused, and a real guide keeps its spaces.
TEST(ws_a_guide_frame_of_only_whitespace_is_a_bad_frame_and_a_real_guide_keeps_its_spaces) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.collab.onMessage(conn, guideFrame("t_priv", "f-blank", " \n\t ", "100:0:client"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("the guide is only whitespace — send \"\" for no guide"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-blank"));
  CHECK(h.trees.byId["t_priv"].guide == Lww<std::string>{});

  h.collab.onMessage(conn, guideFrame("t_priv", "f-spaced", "  Rig first.\n", "101:0:client"));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  CHECK(h.trees.byId["t_priv"].guide == (Lww<std::string>{"  Rig first.\n", Hlc{101, 0, "client"}}));

  h.collab.onMessage(conn, guideFrame("t_priv", "f-clear", "", "102:0:client"));
  REQUIRE_EQ(conn->sent.size(), 3u);
  CHECK_EQ(frameType(conn->sent[2]), std::string("subgraphAck"));
  CHECK(h.trees.byId["t_priv"].guide == (Lww<std::string>{"", Hlc{102, 0, "client"}}));
}

TEST(ws_a_guide_frame_from_a_forks_owner_makes_the_copied_guide_their_own_and_a_stale_one_does_not) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_fork", owner, Visibility::private_);
  h.trees.byId["t_fork"].guide = Lww<std::string>{"Delete what you do not need.", Hlc{500, 0, "srv"}};
  h.trees.byId["t_fork"].guideInherited = true;
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.collab.onMessage(conn, guideFrame("t_fork", "f-stale", "An older word", "400:0:client"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
  CHECK(h.trees.byId["t_fork"].guideInherited);
  CHECK(h.rooms.open(TreeId{"t_fork"})->guideInherited());

  h.collab.onMessage(conn, guideFrame("t_fork", "f-mine", "Prune with care.", "600:0:client"));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  CHECK(h.trees.byId["t_fork"].guide == (Lww<std::string>{"Prune with care.", Hlc{600, 0, "client"}}));
  CHECK_FALSE(h.trees.byId["t_fork"].guideInherited);
  CHECK_FALSE(h.rooms.open(TreeId{"t_fork"})->guideInherited());
}

TEST(ws_a_guide_frame_from_a_non_owner_is_refused_and_one_stamped_past_the_skew_allowance_is_clamped) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-other", "other@example.com");
  h.seed("t_shared", owner, Visibility::unlisted);
  auto stranger = std::make_shared<FakeSocket>();
  auto mine = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), stranger);
  h.collab.onOpen(h.upgrade("s-owner"), mine);

  h.collab.onMessage(stranger, guideFrame("t_shared", "f-theirs", "Mine now", "100:0:r_x"));
  REQUIRE_EQ(stranger->sent.size(), 1u);
  CHECK_EQ(rejectCode(stranger->sent[0]), std::string("not-yours"));

  const std::string runaway = std::to_string(h.clock.nowMs() + 6 * 60 * 1000) + ":0:r_a";
  h.collab.onMessage(mine, guideFrame("t_shared", "f-ahead", "From the future", runaway));
  REQUIRE_EQ(mine->sent.size(), 1u);
  Json::Value skew = parse(mine->sent[0]);
  CHECK_EQ(skew["t"].asString(), std::string("skew"));
  CHECK_EQ(skew["frameId"].asString(), std::string("f-ahead"));
  CHECK_EQ(skew["serverNow"].asUInt64(), h.clock.nowMs());
  CHECK(h.trees.byId["t_shared"].guide == Lww<std::string>{});
}

TEST(ws_a_guide_write_logs_its_completion_line_and_no_line_carries_the_guide) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  const std::string secret = "Ask Maren before the third branch";

  {
    Observed observed;
    h.collab.onMessage(conn, guideFrame("t_priv", "f-guide", secret, "100:0:client"));
    h.collab.onMessage(conn, guideFrame("t_priv", "f-long", secret + std::string(kMaxGuideChars, 'x'), "101:0:client"));

    REQUIRE_EQ(observed.completions.size(), 2u);
    CHECK_EQ(observed.completions[0].operation, std::string("roadmap.ws.subgraph"));
    CHECK_EQ(observed.completions[0].product, std::string("roadmap"));
    CHECK_EQ(observed.completions[0].door, std::string("websocket"));
    CHECK_EQ(observed.completions[0].outcome, std::string("ok"));
    CHECK_EQ(observed.completions[1].operation, std::string("roadmap.ws.subgraph"));
    CHECK_EQ(observed.completions[1].outcome, std::string("bad-frame"));
    std::size_t completionLines = 0;
    for (const std::string& line : observed.lines) {
      CHECK(line.find("Ask Maren") == std::string::npos);
      if (line.find("\"operation\":\"roadmap.ws.subgraph\"") != std::string::npos) ++completionLines;
    }
    CHECK_EQ(completionLines, std::size_t{2});
  }
  CHECK_EQ(h.trees.byId["t_priv"].guide.value, secret);
}

TEST(ws_a_frame_that_does_not_parse_whole_is_refused_by_its_frame_id_and_no_part_of_it_lands) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-tablet", owner);
  h.seed("t_priv", owner, Visibility::private_);
  auto laptop = std::make_shared<FakeSocket>();
  auto tablet = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), laptop);
  h.collab.onOpen(h.upgrade("s-tablet"), tablet);
  h.collab.onMessage(tablet, subscribeFrame("t_priv"));
  const std::size_t tabletSaw = tablet->sent.size();

  const std::vector<std::pair<std::string, std::string>> unreadable = {
      // A whole guide register, then the text breaks inside the nodes that follow it.
      {"f-cut", R"({"t":"subgraph","treeId":"t_priv","frameId":"f-cut",)"
                R"("guide":{"v":"From a broken frame","at":"100:0:client"},"nodes":[{"id":"after",)"},
      // A lone high surrogate, which no UTF-8 text can carry.
      {"f-surrogate", R"({"t":"subgraph","treeId":"t_priv","frameId":"f-surrogate",)"
                      R"("guide":{"v":"Rig \ud83d first","at":"101:0:client"}})"},
      // One whole frame and then another: the text is not one JSON value.
      {"f-twice", R"({"t":"subgraph","treeId":"t_priv","frameId":"f-twice","guide":{"v":"One","at":"102:0:client"}})"
                  R"({"t":"subgraph","treeId":"t_priv","frameId":"f-second"})"},
      // A break before the type: the frame is still answered by the id it named.
      {"f-headless", R"({"frameId":"f-headless","guide":{"v":"Headless","at":"103:0:client"},"t":)"},
  };
  for (const auto& [frameId, text] : unreadable) {
    const std::size_t before = laptop->sent.size();
    h.collab.onMessage(laptop, text);
    REQUIRE_EQ(laptop->sent.size(), before + 1);
    const Json::Value reject = parse(laptop->sent.back());
    CHECK_EQ(reject["t"].asString(), std::string("reject"));
    CHECK_EQ(reject["code"].asString(), std::string("bad-frame"));
    CHECK_EQ(reject["reason"].asString(), std::string("this frame could not be read"));
    CHECK_EQ(reject["frameId"].asString(), frameId);
  }
  CHECK_EQ(parse(laptop->sent[0])["treeId"].asString(), std::string("t_priv"));

  CHECK(h.trees.byId["t_priv"].guide == Lww<std::string>{});
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(0));
  CHECK(h.trees.byId["t_priv"].state.nodes.empty());
  CHECK_EQ(tablet->sent.size(), tabletSaw);

  // A subscribe that breaks is refused too, and joins nothing.
  auto late = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), late);
  h.collab.onMessage(late, R"({"t":"subscribe","treeId":"t_priv","vector":{"r_a":)");
  REQUIRE_EQ(late->sent.size(), 1u);
  CHECK_EQ(rejectCode(late->sent[0]), std::string("bad-frame"));
  CHECK_EQ(parse(late->sent[0])["treeId"].asString(), std::string("t_priv"));
  CHECK_EQ(countOfType(*late, "subgraph"), std::size_t{0});
}

TEST(ws_a_frame_whose_title_or_guide_carries_a_nul_character_is_refused_and_joins_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  const std::string nul("before\0after", 12);

  h.collab.onMessage(conn, guideFrame("t_priv", "f-guide", nul, "100:0:client"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("the guide contains a NUL character"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-guide"));

  Json::Value written(Json::objectValue);
  written["v"] = nul;
  written["at"] = "101:0:client";
  Json::Value titled(Json::objectValue);
  titled["t"] = "subgraph";
  titled["treeId"] = "t_priv";
  titled["frameId"] = "f-title";
  titled["title"] = written;
  h.collab.onMessage(conn, dump(titled));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(rejectCode(conn->sent[1]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[1]), std::string("the title contains a NUL character"));

  CHECK(h.trees.byId["t_priv"].guide == Lww<std::string>{});
  CHECK(h.trees.byId["t_priv"].title == (Lww<std::string>{"Tree", {}}));
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(0));
}

TEST(ws_a_register_whose_value_is_not_a_string_is_refused_and_leaves_the_tree_as_it_was) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, guideFrame("t_priv", "f-set", "A real guide", "100:0:client"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));

  struct Case { const char* field; const char* frameId; Json::Value value; };
  Json::Value numeric(Json::objectValue);
  numeric["v"] = 12345;
  numeric["at"] = "101:0:client";
  Json::Value nulled(Json::objectValue);
  nulled["v"] = Json::Value(Json::nullValue);
  nulled["at"] = "102:0:client";
  Json::Value unvalued(Json::objectValue);
  unvalued["at"] = "103:0:client";
  Json::Value unstamped(Json::objectValue);
  unstamped["v"] = "No stamp";
  const std::vector<Case> cases = {{"guide", "f-numeric", numeric}, {"guide", "f-null", nulled},
                                   {"guide", "f-missing", unvalued}, {"guide", "f-unstamped", unstamped},
                                   {"guide", "f-bare", Json::Value("A bare string")},
                                   {"title", "f-title-numeric", numeric}, {"title", "f-title-null", nulled}};
  for (const Case& c : cases) {
    Json::Value frame(Json::objectValue);
    frame["t"] = "subgraph";
    frame["treeId"] = "t_priv";
    frame["frameId"] = c.frameId;
    frame[c.field] = c.value;
    const std::size_t before = conn->sent.size();
    h.collab.onMessage(conn, dump(frame));
    REQUIRE_EQ(conn->sent.size(), before + 1);
    CHECK_EQ(rejectCode(conn->sent.back()), std::string("bad-frame"));
    CHECK_EQ(rejectReason(conn->sent.back()), std::string("this frame could not be read"));
    CHECK_EQ(parse(conn->sent.back())["frameId"].asString(), std::string(c.frameId));
  }

  CHECK(h.trees.byId["t_priv"].guide == (Lww<std::string>{"A real guide", Hlc{100, 0, "client"}}));
  CHECK(h.trees.byId["t_priv"].title == (Lww<std::string>{"Tree", {}}));
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(1));
}

TEST(ws_a_frame_onto_a_tree_whose_row_went_away_under_its_live_room_answers_no_such_tree) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  h.trees.deletedIds.insert("t_priv");  // soft-deleted outside this process's room registry
  const std::size_t before = conn->sent.size();

  h.collab.onMessage(conn, nodeFrame("t_priv", "f-ghost", "A ghost's step"));

  REQUIRE(conn->sent.size() > before);
  const Json::Value reject = lastFrameOfType(*conn, "reject");
  CHECK_EQ(reject["code"].asString(), std::string("no-such-tree"));
  CHECK_EQ(reject["frameId"].asString(), std::string("f-ghost"));
  CHECK_EQ(countOfType(*conn, "subgraphAck"), std::size_t{0});
  CHECK(h.trees.byId["t_priv"].state.nodes.empty());
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_priv"}));
  h.collab.onMessage(conn, subscribeFrame("t_priv"));
  CHECK_EQ(rejectCode(conn->sent.back()), std::string("no-such-tree"));
}

TEST(ws_a_frame_whose_save_throws_answers_its_author_server_error_and_files_one_issue) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.trees.savesFail = true;

  {
    Observed observed;
    h.collab.onMessage(conn, guideFrame("t_priv", "f-refused", "Ask Maren before the third branch", "100:0:client"));

    REQUIRE_EQ(conn->sent.size(), 1u);
    const Json::Value reject = parse(conn->sent[0]);
    CHECK_EQ(reject["t"].asString(), std::string("reject"));
    CHECK_EQ(reject["code"].asString(), std::string("server-error"));
    CHECK_EQ(reject["reason"].asString(), std::string("the server could not save this edit"));
    CHECK_EQ(reject["frameId"].asString(), std::string("f-refused"));
    CHECK_EQ(reject["treeId"].asString(), std::string("t_priv"));
    REQUIRE_EQ(observed.completions.size(), 1u);
    CHECK_EQ(observed.completions[0].operation, std::string("roadmap.ws.subgraph"));
    CHECK_EQ(observed.completions[0].outcome, std::string("failed"));
    CHECK_EQ(observed.issues, std::vector<std::string>{"roadmap.ws.subgraph"});
    for (const std::string& line : observed.lines) {
      CHECK(line.find("malformed") == std::string::npos);
      CHECK(line.find("Ask Maren") == std::string::npos);
      CHECK(line.find("the write was refused") == std::string::npos);
    }
  }
  CHECK(h.trees.byId["t_priv"].guide == Lww<std::string>{});
}

TEST(ws_concurrent_opens_frames_converge_on_the_later_stamp_and_a_frame_without_the_field_clears_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-tablet", owner);
  h.seed("t_priv", owner, Visibility::private_);
  auto laptop = std::make_shared<FakeSocket>();
  auto tablet = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), laptop);
  h.collab.onOpen(h.upgrade("s-tablet"), tablet);
  const char* created = R"({"id":"door","createdAt":"1000:0:r_a","label":"Door","labelAt":"1000:0:r_a"})";
  h.collab.onMessage(laptop, registerFrame("t_priv", "f-create", created));

  const char* fromTablet = R"({"id":"door","opens":"t_00000000000000b2","opensAt":"2000:0:r_b"})";
  const char* fromLaptop = R"({"id":"door","opens":"t_00000000000000a1","opensAt":"2000:0:r_a"})";
  h.collab.onMessage(tablet, registerFrame("t_priv", "f-tablet", fromTablet));
  h.collab.onMessage(laptop, registerFrame("t_priv", "f-laptop", fromLaptop));
  CHECK_EQ(frameType(laptop->sent.back()), std::string("subgraphAck"));
  CHECK_EQ(frameType(tablet->sent.back()), std::string("subgraphAck"));
  NodeStateEntry door;
  door.id = NodeId{"door"};
  door.createdAt = door.labelAt = Hlc{1000, 0, "r_a"};
  door.label = "Door";
  door.opens = TreeId{"t_00000000000000b2"};
  door.opensAt = Hlc{2000, 0, "r_b"};
  CHECK(h.trees.byId["t_priv"].state == (GraphState{{door}, {}}));

  // The frame a browser that does not know the register sends for a rename.
  const char* renamed = R"({"id":"door","label":"Front door","labelAt":"3000:0:r_a"})";
  h.collab.onMessage(laptop, registerFrame("t_priv", "f-rename", renamed));
  CHECK_EQ(frameType(laptop->sent.back()), std::string("subgraphAck"));
  door.label = "Front door";
  door.labelAt = Hlc{3000, 0, "r_a"};
  CHECK(h.trees.byId["t_priv"].state == (GraphState{{door}, {}}));
  std::vector<Seq> deeds;  // the create and the rename: a frame that only writes `opens` is no deed
  for (const AppliedOp& op : h.ops.byTree["t_priv"]) deeds.push_back(op.seq);
  CHECK_EQ(deeds, (std::vector<Seq>{1, 4}));

  auto fresh = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), fresh);
  h.collab.onMessage(fresh, subscribeFrame("t_priv"));
  const Json::Value delta = lastFrameOfType(*fresh, "subgraph");
  REQUIRE_EQ(delta["nodes"].size(), 1u);
  CHECK_EQ(delta["nodes"][0]["opens"].asString(), std::string("t_00000000000000b2"));
  CHECK_EQ(delta["nodes"][0]["opensAt"].asString(), std::string("2000:0:r_b"));
  CHECK_EQ(delta["coverage"]["r_b"].asString(), std::string("2000:0:r_b"));
}

TEST(ws_a_frame_whose_opens_is_past_the_id_cap_is_rejected_and_one_at_the_cap_lands) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  Json::Value node = parse(R"({"id":"door","createdAt":"1000:0:r_a","opensAt":"1000:0:r_a"})");

  node["opens"] = std::string(kMaxIdLength + 1, 't');
  h.collab.onMessage(conn, registerFrame("t_priv", "f-over", dump(node)));
  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("bad-frame"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("node \"door\": opens would be 129 characters, 1 over the 128 cap"));
  CHECK_EQ(parse(conn->sent[0])["frameId"].asString(), std::string("f-over"));
  CHECK(h.trees.byId["t_priv"].state == GraphState{});

  node["opens"] = std::string(kMaxIdLength, 't');
  h.collab.onMessage(conn, registerFrame("t_priv", "f-cap", dump(node)));
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(frameType(conn->sent[1]), std::string("subgraphAck"));
  NodeStateEntry door;
  door.id = NodeId{"door"};
  door.createdAt = door.opensAt = Hlc{1000, 0, "r_a"};
  door.opens = TreeId{std::string(kMaxIdLength, 't')};
  CHECK(h.trees.byId["t_priv"].state == (GraphState{{door}, {}}));
}

TEST(ws_the_tree_a_node_opens_reaches_its_owners_connections_and_no_other_subscriber_live_or_on_subscribe) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-tablet", owner);
  h.signIn("s-stranger", "stranger@example.com");
  h.seed("t_pub", owner, Visibility::public_);
  auto laptop = std::make_shared<FakeSocket>();
  auto tablet = std::make_shared<FakeSocket>();
  auto stranger = std::make_shared<FakeSocket>();
  auto signedOut = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), laptop);
  h.collab.onOpen(h.upgrade("s-tablet"), tablet);
  h.collab.onOpen(h.upgrade("s-stranger"), stranger);
  h.collab.onOpen(h.upgrade(""), signedOut);
  for (const auto& conn : {tablet, stranger, signedOut}) h.collab.onMessage(conn, subscribeFrame("t_pub"));
  NodeStateEntry whole;
  whole.id = NodeId{"door"};
  whole.label = "Door";
  whole.createdAt = whole.labelAt = Hlc{1000, 0, "r_a"};
  whole.opens = TreeId{"t_00000000000000f2"};
  whole.opensAt = Hlc{1000, 0, "r_a"};
  NodeStateEntry withheld = whole;
  withheld.opens = TreeId{};
  withheld.opensAt = Hlc{};
  const Json::Value wholeNodes = toJson(GraphState{{whole}, {}})["nodes"];
  const Json::Value withheldNodes = toJson(GraphState{{withheld}, {}})["nodes"];

  const char* created =
      R"({"id":"door","createdAt":"1000:0:r_a","label":"Door","labelAt":"1000:0:r_a","opens":"t_00000000000000f2","opensAt":"1000:0:r_a"})";
  h.collab.onMessage(laptop, registerFrame("t_pub", "f-create", created));
  CHECK_EQ(frameType(laptop->sent.back()), std::string("subgraphAck"));
  CHECK_EQ(lastFrameOfType(*tablet, "subgraph")["intent"].asString(), std::string("live"));
  CHECK_EQ(lastFrameOfType(*tablet, "subgraph")["nodes"], wholeNodes);
  for (const auto& reader : {stranger, signedOut}) {
    const Json::Value live = lastFrameOfType(*reader, "subgraph");
    CHECK_EQ(live["intent"].asString(), std::string("live"));
    CHECK_EQ(live["seq"].asInt64(), 1);
    CHECK_EQ(live["nodes"], withheldNodes);
  }

  // A frame that moves only the pointer still reaches a reader, with its seq and nothing in it.
  h.collab.onMessage(laptop, registerFrame("t_pub", "f-retarget", R"({"id":"door","opens":"t_00000000000000f3","opensAt":"2000:0:r_a"})"));
  CHECK_EQ(lastFrameOfType(*tablet, "subgraph")["nodes"][0]["opens"].asString(), std::string("t_00000000000000f3"));
  for (const auto& reader : {stranger, signedOut}) {
    const Json::Value live = lastFrameOfType(*reader, "subgraph");
    CHECK_EQ(live["seq"].asInt64(), 2);
    CHECK_EQ(live["nodes"], Json::Value(Json::arrayValue));
  }

  auto strangerAgain = std::make_shared<FakeSocket>();
  auto ownerAgain = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-stranger"), strangerAgain);
  h.collab.onOpen(h.upgrade("s-owner"), ownerAgain);
  h.collab.onMessage(strangerAgain, subscribeFrame("t_pub"));
  h.collab.onMessage(ownerAgain, subscribeFrame("t_pub"));
  CHECK_EQ(lastFrameOfType(*strangerAgain, "subgraph")["nodes"], withheldNodes);
  whole.opens = TreeId{"t_00000000000000f3"};
  whole.opensAt = Hlc{2000, 0, "r_a"};
  CHECK_EQ(lastFrameOfType(*ownerAgain, "subgraph")["nodes"], toJson(GraphState{{whole}, {}})["nodes"]);

  // A subscriber whose vector covers everything but the pointer is sent no node at all.
  Json::Value behind(Json::objectValue);
  behind["t"] = "subscribe";
  behind["treeId"] = "t_pub";
  behind["vector"]["r_a"] = "1000:0:r_a";
  auto strangerBehind = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-stranger"), strangerBehind);
  h.collab.onMessage(strangerBehind, dump(behind));
  CHECK_EQ(lastFrameOfType(*strangerBehind, "subgraph")["nodes"], Json::Value(Json::arrayValue));
}

TEST(ws_an_owners_connection_whose_session_was_revoked_stops_receiving_the_tree_a_node_opens) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-tablet", owner);
  h.seed("t_pub", owner, Visibility::public_);
  auto laptop = std::make_shared<FakeSocket>();
  auto tablet = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), laptop);
  h.collab.onOpen(h.upgrade("s-tablet"), tablet);
  h.collab.onMessage(tablet, subscribeFrame("t_pub"));
  h.collab.onMessage(laptop, registerFrame("t_pub", "f-open", R"({"id":"door","createdAt":"1000:0:r_a","opens":"t_00000000000000f2","opensAt":"1000:0:r_a"})"));
  CHECK_EQ(lastFrameOfType(*tablet, "subgraph")["nodes"][0]["opens"].asString(), std::string("t_00000000000000f2"));

  h.authRepo.deleteSession(h.tokens.digestOf("s-tablet"));
  h.clock.now += 61'000;  // past the one-minute re-proof
  h.collab.reproveReaders();
  h.collab.onMessage(laptop, registerFrame("t_pub", "f-retarget", R"({"id":"door","opens":"t_00000000000000f3","opensAt":"2000:0:r_a"})"));
  const Json::Value live = lastFrameOfType(*tablet, "subgraph");
  CHECK_EQ(live["seq"].asInt64(), 2);
  CHECK_EQ(live["nodes"], Json::Value(Json::arrayValue));
  CHECK_EQ(countOfType(*tablet, "reject"), 0u);

  // Neither the narrowed connection nor a fresh one on the revoked session is answered as a writer.
  auto again = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-tablet"), again);
  NodeStateEntry withheld;
  withheld.id = NodeId{"door"};
  withheld.createdAt = Hlc{1000, 0, "r_a"};
  Json::Value answer = parse(R"({"t":"subgraph","v":1,"treeId":"t_pub","frameId":"delta-2","actor":"srv","intent":"delta",
                                 "edges":[],"kinds":[],"gestures":[],"title":null,"guide":null,
                                 "coverage":{"r_a":"2000:0:r_a"},"seq":2,"reach":"reader"})");
  answer["nodes"] = toJson(GraphState{{withheld}, {}})["nodes"];
  for (const auto& conn : {tablet, again}) {
    h.collab.onMessage(conn, subscribeFrame("t_pub"));
    CHECK_EQ(lastFrameOfType(*conn, "subgraph"), answer);
  }
}

TEST(ws_a_frame_whose_opens_is_not_a_string_is_refused_and_leaves_the_tree_as_it_was) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, registerFrame("t_priv", "f-create", R"({"id":"door","createdAt":"1000:0:r_a"})"));
  REQUIRE_EQ(conn->sent.size(), 1u);
  const GraphState before = h.trees.byId["t_priv"].state;

  for (const char* value : {"7", "true", R"({"id":"t_x"})", R"(["t_x"])"}) {
    const std::string node = std::string(R"({"id":"door","opens":)") + value + R"(,"opensAt":"2000:0:r_a"})";
    const std::size_t answered = conn->sent.size();
    h.collab.onMessage(conn, registerFrame("t_priv", value, node));
    REQUIRE_EQ(conn->sent.size(), answered + 1);
    CHECK_EQ(rejectCode(conn->sent.back()), std::string("bad-frame"));
    CHECK_EQ(rejectReason(conn->sent.back()), std::string("this frame could not be read"));
    CHECK_EQ(parse(conn->sent.back())["frameId"].asString(), std::string(value));
  }
  CHECK(h.trees.byId["t_priv"].state == before);
  CHECK_EQ(h.trees.byId["t_priv"].head, static_cast<Seq>(1));
}

// The mark told its maker it did something when the node follows its tree: it is not stored, and the ack says which.
TEST(ws_progress_does_not_record_the_writers_mark_on_a_node_that_opens_a_tree_and_names_it_in_the_ack) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_main"));
  conn->sent.clear();

  {
    Observed observed;
    h.collab.onMessage(conn, progressFrame("t_main", "f1",
                                           {{"plain", "complete", "900:0:r_a"}, {"idea", "complete", "901:0:r_a"},
                                            {"ghost", "none", "902:0:r_a"}, {"idea", "none", "903:0:r_a"}}));
    h.collab.onMessage(conn, progressFrame("t_main", "f2", {{"idea", "complete", "904:0:r_a"}}));

    REQUIRE_EQ(observed.completions.size(), 2u);
    CHECK_EQ(observed.completions[0].operation + " " + observed.completions[0].outcome, std::string("roadmap.ws.progress ok"));
    CHECK_EQ(observed.completions[1].operation + " " + observed.completions[1].outcome, std::string("roadmap.ws.progress opens-a-tree"));
    CHECK(observed.issues.empty());
    for (const std::string& line : observed.lines) CHECK(line.find("t_sub") == std::string::npos);
  }

  REQUIRE_EQ(conn->sent.size(), 3u);
  Json::Value echo = parse(conn->sent[0]);
  for (Json::Value& mark : echo["marks"]) mark.removeMember("markedAt");
  CHECK_EQ(echo, parse(R"({"t":"progress","treeId":"t_main","marks":[{"node":"ghost","status":"none","at":"902:0:r_a"},
                                                                    {"node":"plain","status":"complete","at":"900:0:r_a"}]})"));
  CHECK_EQ(parse(conn->sent[1]), parse(R"({"t":"progressAck","treeId":"t_main","frameId":"f1",
      "refused":[{"node":"idea","code":"opens-a-tree"},{"node":"idea","code":"opens-a-tree"}]})"));
  CHECK_EQ(parse(conn->sent[2]), parse(R"({"t":"progressAck","treeId":"t_main","frameId":"f2",
      "refused":[{"node":"idea","code":"opens-a-tree"}]})"));
  const Progress stored = h.progressRepo.load(TreeId{"t_main"}, owner);
  CHECK(stored.completed == std::set<NodeId>{NodeId{"plain"}});
  CHECK(stored.cleared == std::set<NodeId>{NodeId{"ghost"}});
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_sub"}}, {TreeId{"t_sub"}}}));
}

// Removing a tree takes the step of the owner's other tree that opened it, and a page open on that tree is sent the
// delete live, in one frame, as a delete_node's is.
TEST(ws_removing_a_tree_sends_a_page_open_on_a_tree_that_opened_it_the_delete_of_that_step_live) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  auto page = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), page);
  h.collab.onMessage(page, subscribeFrame("t_main"));
  page->sent.clear();

  Cascade went;
  went.removed[TreeId{"t_main"}] = {NodeId{"idea"}};
  CHECK(h.trees_registry.remove(TreeId{"t_sub"}, owner) == (std::variant<Cascade, TreeRegistry::RemovalRefusal>{went}));

  REQUIRE_EQ(page->sent.size(), 1u);
  const Json::Value live = parse(page->sent[0]);
  CHECK_EQ(live["t"].asString(), std::string("subgraph"));
  CHECK_EQ(live["intent"].asString(), std::string("live"));
  CHECK_EQ(live["treeId"].asString(), std::string("t_main"));
  REQUIRE_EQ(live["nodes"].size(), 1u);
  CHECK_EQ(live["nodes"][0]["id"].asString(), std::string("idea"));
  CHECK_FALSE(live["nodes"][0]["deletedAt"].asString().empty());
  CHECK(live["edges"].empty());
}

// Removing the tree an owner's page is open on — the web's delete of the roadmap being viewed — owes that page a reject,
// sent while the removal is served. That frame is the page's, not the removal's: on either door the removal's own line
// is still its own, and a frame's own refusal still finishes the frame's write under its code.
TEST(ws_a_reject_the_removal_sends_a_page_open_on_its_tree_leaves_the_removals_own_line_its_own) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  RoadmapTools tools{h.rooms, h.progress, h.clock, h.trees_registry, h.edits, "https://app.example"};
  CompositeToolHost gate(std::vector<ToolModule>{{tools, ""}});
  const auto pageOn = [&](const char* tree) {
    h.seedSteps(tree, owner, Visibility::private_, "");
    auto page = std::make_shared<FakeSocket>();
    h.collab.onOpen(h.upgrade("s-owner"), page);
    h.collab.onMessage(page, subscribeFrame(tree));
    page->sent.clear();
    return page;
  };
  std::vector<std::string> lines;
  {
    Observed observed;
    auto restPage = pageOn("t_rest");
    {
      WriteObservation route{"roadmap.DELETE.v1.trees.id", "roadmap", "rest"};
      WriteContext context{route};
      CHECK(std::holds_alternative<Cascade>(h.trees_registry.remove(TreeId{"t_rest"}, owner)));
      route.finish();
    }
    auto mcpPage = pageOn("t_mcp");
    Json::Value args(Json::objectValue);
    args["treeId"] = "t_mcp";
    CHECK_FALSE(gate.callTool("delete_tree", args, ToolCaller{owner, ToolScope::everything()}).isError);
    REQUIRE_EQ(restPage->sent.size(), 1u);
    REQUIRE_EQ(mcpPage->sent.size(), 1u);
    CHECK_EQ(rejectCode(restPage->sent[0]) + " " + rejectCode(mcpPage->sent[0]), std::string("no-such-tree no-such-tree"));
    // The pages' upgrades refresh their session; what is under test is the removal's own lines.
    for (const WriteCompletion& line : observed.completions)
      if (line.operation != "auth.session.refresh") lines.push_back(line.operation + " " + line.door + " " + line.outcome);
  }
  CHECK(lines == (std::vector<std::string>{"roadmap.DELETE.v1.trees.id rest ok", "mcp.roadmap_delete_tree mcp ok"}));

  auto writer = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), writer);
  Observed observed;
  h.collab.onMessage(writer, writeFrame("t_rest"));
  REQUIRE_EQ(observed.completions.size(), 1u);
  CHECK_EQ(observed.completions[0].operation + " " + observed.completions[0].outcome,
           std::string("roadmap.ws.subgraph no-such-tree"));
}

TEST(ws_progress_ack_carries_no_refused_key_when_no_mark_was_refused) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  h.collab.onMessage(conn, progressFrame("t_main", "f1", {{"plain", "complete", "900:0:r_a"}}));

  CHECK_EQ(lastFrameOfType(*conn, "progressAck"), parse(R"({"t":"progressAck","treeId":"t_main","frameId":"f1"})"));
  CHECK(h.progressRepo.load(TreeId{"t_main"}, owner).completed == std::set<NodeId>{NodeId{"plain"}});
}

// A refusal, or a read made only where a node opens a tree, would tell such a reader what the owner alone is told.
TEST(ws_progress_from_a_reader_who_cannot_write_the_tree_is_recorded_and_acked_as_on_a_twin_that_opens_nothing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  UserId stranger = h.signIn("s-other", "other@example.com");
  h.seedSteps("t_main", owner, Visibility::public_, "t_sub");
  h.seedSteps("t_twin", owner, Visibility::public_, "");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_main"));
  h.collab.onMessage(conn, subscribeFrame("t_twin"));

  std::vector<Json::Value> answered;
  for (const char* tree : {"t_main", "t_twin"}) {
    conn->sent.clear();
    h.collab.onMessage(conn, progressFrame(tree, "f1", {{"idea", "complete", "900:0:r_a"}, {"plain", "none", "901:0:r_a"}}));
    REQUIRE_EQ(conn->sent.size(), 2u);
    CHECK_EQ(parse(conn->sent[1])["treeId"].asString(), std::string(tree));
    for (const std::string& text : conn->sent) {
      Json::Value frame = parse(text);
      frame.removeMember("treeId");
      answered.push_back(frame);
    }
    const Progress stored = h.progressRepo.load(TreeId{tree}, stranger);
    CHECK(stored.completed == std::set<NodeId>{NodeId{"idea"}});
    CHECK(stored.cleared == std::set<NodeId>{NodeId{"plain"}});
  }

  REQUIRE_EQ(answered.size(), 4u);
  CHECK_EQ(answered[0], answered[2]);
  CHECK_EQ(answered[1], answered[3]);
  CHECK_EQ(answered[1], parse(R"({"t":"progressAck","frameId":"f1"})"));
  CHECK(h.trees.openedReads.empty());
}

// A stranger's frame must not wait on the owner's statements: that wait would say the tree holds a pointer.
TEST(ws_progress_follows_pointers_in_one_read_and_writes_after_the_trees_strand_is_released) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  h.seedSteps("t_plain", owner, Visibility::private_, "");
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  std::vector<std::string> statementsUnderAFreeStrand;
  const auto during = [&](const char* statement) {
    return [&, statement] {
      std::thread other([&] {
        std::mutex& strand = h.rooms.strandFor(TreeId{"t_main"});
        if (!strand.try_lock()) return;
        strand.unlock();
        statementsUnderAFreeStrand.push_back(statement);
      });
      other.join();
    };
  };
  h.trees.duringOpenedRead = during("read");
  h.progressRepo.duringBatchWrite = during("write");

  h.collab.onMessage(conn, progressFrame("t_main", "f1", {{"plain", "complete", "900:0:r_a"}, {"idea", "complete", "901:0:r_a"}}));
  CHECK_EQ(statementsUnderAFreeStrand, (std::vector<std::string>{"read", "write"}));
  CHECK_EQ(h.trees.openedReads, (std::vector<std::set<TreeId>>{{TreeId{"t_sub"}}}));

  h.collab.onMessage(conn, progressFrame("t_plain", "f2", {{"idea", "complete", "902:0:r_a"}}));
  CHECK_EQ(h.trees.openedReads.size(), 1u);
  CHECK(h.progressRepo.load(TreeId{"t_plain"}, owner).completed == std::set<NodeId>{NodeId{"idea"}});
}

// An infrastructure failure after the gates is not the socket's to relay: the frame stays unacked and re-flushes.
TEST(ws_progress_whose_pointers_cannot_be_followed_is_left_unanswered_records_nothing_and_files_one_issue) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.trees.openedReadsFail = true;

  {
    Observed observed;
    h.collab.onMessage(conn, progressFrame("t_main", "f1", {{"plain", "complete", "900:0:r_a"}}));

    REQUIRE_EQ(observed.completions.size(), 1u);
    CHECK_EQ(observed.completions[0].operation + " " + observed.completions[0].outcome, std::string("roadmap.ws.progress failed"));
    CHECK_EQ(observed.issues, std::vector<std::string>{"roadmap.ws.progress"});
    for (const std::string& line : observed.lines) {
      CHECK(line.find("t_sub") == std::string::npos);
      CHECK(line.find("connection reset") == std::string::npos);
    }
  }
  CHECK(conn->sent.empty());
  CHECK(h.progressRepo.load(TreeId{"t_main"}, owner).marks.empty());
}

// A frame's marks are judged against the nodes that open a tree and nothing else of the room, so no frame copies the tree out.
TEST(ws_progress_copies_the_whole_tree_out_of_its_room_for_no_connection) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.signIn("s-other", "other@example.com");
  h.seedSteps("t_main", owner, Visibility::public_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  h.seedSteps("t_plain", owner, Visibility::private_, "");
  auto mine = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), mine);
  auto theirs = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), theirs);
  const TreeRoom& room = *h.rooms.open(TreeId{"t_main"});
  const TreeRoom& plain = *h.rooms.open(TreeId{"t_plain"});
  const std::size_t copies = room.snapshots();
  const std::size_t plainCopies = plain.snapshots();

  h.collab.onMessage(mine, progressFrame("t_main", "f1", {{"plain", "complete", "900:0:r_a"}, {"idea", "complete", "901:0:r_a"}}));
  h.collab.onMessage(theirs, progressFrame("t_main", "f2", {{"idea", "complete", "902:0:r_b"}}));
  h.collab.onMessage(mine, progressFrame("t_plain", "f3", {{"idea", "complete", "903:0:r_a"}}));

  CHECK_EQ(countOfType(*mine, "progressAck"), 2u);
  CHECK_EQ(countOfType(*theirs, "progressAck"), 1u);
  CHECK_EQ(room.snapshots(), copies);
  CHECK_EQ(plain.snapshots(), plainCopies);
}

// The write line says what the frame came to: nothing recorded and a mark refused, though another mark only lost to a later stamp.
TEST(ws_a_progress_frame_that_recorded_no_mark_and_was_refused_one_completes_as_opens_a_tree) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seedSteps("t_main", owner, Visibility::private_, "t_sub");
  h.seedSteps("t_sub", owner, Visibility::private_, "");
  h.progressRepo.setStatus(TreeId{"t_main"}, owner, NodeId{"plain"}, ProgressStatus::complete, false, Hlc{900, 0, "r_desk"}, 900);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);

  {
    Observed observed;
    h.collab.onMessage(conn, progressFrame("t_main", "f1", {{"idea", "complete", "901:0:r_a"}, {"plain", "none", "500:0:r_stale"}}));
    h.collab.onMessage(conn, progressFrame("t_main", "f2", {{"plain", "none", "501:0:r_stale"}}));

    REQUIRE_EQ(observed.completions.size(), 2u);
    CHECK_EQ(observed.completions[0].operation + " " + observed.completions[0].outcome, std::string("roadmap.ws.progress opens-a-tree"));
    CHECK_EQ(observed.completions[1].operation + " " + observed.completions[1].outcome, std::string("roadmap.ws.progress ok"));
  }
  REQUIRE_EQ(conn->sent.size(), 2u);
  CHECK_EQ(parse(conn->sent[0]), parse(R"({"t":"progressAck","treeId":"t_main","frameId":"f1","refused":[{"node":"idea","code":"opens-a-tree"}]})"));
  CHECK_EQ(parse(conn->sent[1]), parse(R"({"t":"progressAck","treeId":"t_main","frameId":"f2"})"));
  CHECK(h.progressRepo.load(TreeId{"t_main"}, owner).completed == std::set<NodeId>{NodeId{"plain"}});
}
