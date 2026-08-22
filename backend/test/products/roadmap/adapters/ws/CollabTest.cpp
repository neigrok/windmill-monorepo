#include "products/roadmap/adapters/ws/Collab.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "platform/domain/Access.h"
#include "products/roadmap/domain/Command.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <trantor/net/InetAddress.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// A drogon WebSocketConnection fake: it captures every frame the server sends and stays open,
// so a test can watch which frames reach a connection and whether a broadcast finds it.
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
  FakeTreeRepository trees;
  FakeOpLog ops;
  WsPresenceBus bus;  // the real bus, so a broadcast actually finds (or misses) a connection
  RoomRegistry rooms{trees, ops, bus};
  FakeProgressRepository progressRepo;
  ProgressService progress{progressRepo};
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  AuthService auth{authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works"};
  PresenceHub presence;
  // The real delete door, so a retirement in these tests is the one the API calls.
  TreeRegistry trees_registry{trees, progressRepo, tokens, Hlc{1, 0, "genesis"}, rooms, clock};
  // The app's own origin is the whole allowlist here, as it is in production when
  // WINDMILL_ALLOWED_ORIGINS names nothing extra.
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

// A client-authored write frame — the sole browser write path. The envelope is enough to reach
// the authz gate; an empty subgraph never has to be joined for a rejected write.
std::string writeFrame(const std::string& treeId) {
  Json::Value f(Json::objectValue);
  f["t"] = "subgraph";
  f["treeId"] = treeId;
  f["frameId"] = "f1";
  return dump(f);
}

// One mark as a client sends it: the node, the status, and the stamp the marking replica minted.
struct Mark {
  std::string node;
  std::string status;
  std::string at;
};

// A client-authored progress frame — a batch of stamped registers, the private lane's only write.
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

std::string rejectReason(const std::string& text) { return parse(text).get("reason", "").asString(); }
// The code is the half a client branches on; the reason is prose and may change under it.
std::string rejectCode(const std::string& text) { return parse(text).get("code", "").asString(); }

// Broadcast one live frame to whoever is subscribed to `tree` — the probe for "is this
// connection on the bus?".
void broadcastTo(WsPresenceBus& bus, const char* tree) {
  Subgraph frame;
  frame.treeId = TreeId{tree};
  bus.broadcastSubgraph(TreeId{tree}, 2, frame);
}

std::string frameType(const std::string& text) { return parse(text).get("t", "").asString(); }

// The last frame of a given type this socket was sent — a write answers with an ack AND an echo,
// so "the last thing sent" is not specific enough to assert on.
// How many frames of a kind this socket was sent. A subscribe now answers with BOTH lanes — the
// structure delta and this account's progress graft — so "how many frames arrived" no longer
// identifies what arrived, and counting the kind under test says what these cases actually mean.
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

// The actor id carried by the last "peer join" frame a connection received — what a co-viewer,
// including a total stranger, learns about the person who just arrived.
std::string announcedActor(const FakeSocket& conn) {
  for (auto it = conn.sent.rbegin(); it != conn.sent.rend(); ++it) {
    Json::Value frame = parse(*it);
    if (frame.get("t", "").asString() == "peer" && frame.get("event", "").asString() == "join")
      return frame.get("actor", "").asString();
  }
  return "";
}

// The profile name carried by the last "peer join" frame a connection received — how a peer
// is announced to everyone already in the tree.
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
  CHECK_EQ(countOfType(*conn, "reject"), 0u);   // the delta, not a rejection
  CHECK_EQ(countOfType(*conn, "progress"), 1u); // …and this account's own overlay beside it

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(countOfType(*conn, "subgraph"), 2u);  // subscribed: the live broadcast reached it
}

TEST(ws_anon_on_a_private_tree_is_rejected_and_never_joins_the_bus) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);  // no cookie — an anonymous guest
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(parse(conn->sent[0])["treeId"].asString(), std::string("t_priv"));

  // The decisive property: an unreadable caller is never on the bus, so no later broadcast
  // can reach it.
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), 1u);  // still just the reject — the broadcast missed it
}

TEST(ws_non_owner_on_a_private_tree_is_rejected_and_never_joins_the_bus) {
  Harness h;
  h.signIn("s-other", "other@example.com");  // a signed-in non-owner
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-other"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), 1u);  // not on the bus
}

TEST(ws_anon_on_an_unlisted_tree_receives_the_delta_and_joins_the_bus) {
  Harness h;
  h.seed("t_shared", UserId{"owner"}, Visibility::unlisted);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);  // anonymous, but unlisted is readable by id
  h.collab.onMessage(conn, subscribeFrame("t_shared"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_FALSE(frameType(conn->sent[0]) == "reject");

  broadcastTo(h.bus, "t_shared");
  CHECK_EQ(conn->sent.size(), 2u);  // subscribed
}

TEST(ws_subscribe_to_an_absent_tree_is_rejected) {
  Harness h;
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_ghost"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
}

// The write path must answer a private tree you cannot read exactly as it answers an absent one —
// byte-identical but for the id — or the reject string is an existence oracle: it would tell a
// stranger which private tree ids name something real. This is the read gate the read paths carry,
// finally on the write path too.
TEST(ws_write_to_a_private_tree_you_dont_own_reads_as_absent) {
  Harness h;
  h.signIn("s-other", "other@example.com");  // a signed-in non-owner
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

// The gate did not over-broaden: a tree you CAN read but do not own (unlisted/public) still names
// the truth — it exists, it is simply not yours — because that fact is not a secret.
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

// An unowned private tree — a crash-orphaned row — is not writable over the socket: canRead
// denies it, so a stranger who knows the id can neither read it nor seize it.
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

// The demo tree's exact shape: owner NULL, visibility public. canRead admits it (that is the
// point of a demo), and the write gate used to be "deny only if someone ELSE owns it" — a
// no-op on a row nobody owns. So any signed-in visitor could edit the hosted demo AND take
// permanent ownership of it by doing so, then flip it private or delete it. An unowned tree is
// nobody's to write: the frame is refused, and the row is left unowned and unchanged. The refusal
// says so plainly — "belongs to another account" would name an account that does not exist, which
// on the demo is the one sentence every locked-out visitor would ever read.
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
  CHECK_FALSE(h.trees.byId["t_demo"].owner.has_value());  // still nobody's
  CHECK(h.trees.byId["t_demo"] == before);                // and byte-identical: nothing was written
  CHECK(h.ops.byTree["t_demo"].empty());                  // not even an op logged

  // Still readable by the world — the demo is not broken by being unwritable.
  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_demo"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  CHECK_FALSE(frameType(reader->sent[0]) == "reject");
}

// The whole gate leans on principal.user being an authenticated caller by the time it runs, so a
// guest must be turned away at the auth check FIRST — before the tree is ever looked up. And "sign
// in to edit" is the same for a real tree and an absent one, so the auth gate is not an oracle either.
TEST(ws_guest_write_is_turned_away_at_auth_before_the_tree_is_looked_up) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto onReal = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), onReal);  // no cookie — a guest
  h.collab.onMessage(onReal, writeFrame("t_priv"));

  auto onAbsent = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), onAbsent);
  h.collab.onMessage(onAbsent, writeFrame("t_ghost"));

  CHECK_EQ(rejectReason(onReal->sent[0]), std::string("sign in to edit"));
  CHECK_EQ(rejectReason(onAbsent->sent[0]), std::string("sign in to edit"));
  CHECK_EQ(rejectCode(onReal->sent[0]), std::string("sign-in-required"));
  CHECK_EQ(rejectCode(onAbsent->sent[0]), std::string("sign-in-required"));
}

// A guest's progress mark is refused with the same code as a guest's edit — one session
// suspicion, whichever frame carried it — and the mark rides back so the client can requeue.
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
  // The mark is NOT echoed back for the client to requeue. It does not need to be: an unacked
  // frame stays uncovered in the sender's lattice and re-flushes on its own (§12), so naming the
  // frame is the whole answer. Echoing the mark would be a second, lossier outbox beside the one
  // that already cannot lose it.
  CHECK_EQ(reject["frameId"].asString(), std::string("f1"));
  CHECK_FALSE(reject.isMember("nodeId"));
}

// The lane's happy path: the client's own stamps go in unmodified — the server does not restamp,
// because a stamp is immutable from the moment it is minted (§3) — and the ack is what tells the
// sender its coverage may advance.
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
  CHECK(stored.marks.at(NodeId{"b"}).status == ProgressStatus::active);
  CHECK_EQ(lastFrameOfType(*conn, "progressAck")["frameId"].asString(), std::string("f7"));
}

// A whole batch converges as one: the echo carries every register back, stamped, in the same frame
// shape the graft serves — including the server's receipt instant, which is how the marking device
// learns when its own mark was recorded without asking again.
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
  CHECK_EQ(echo["marks"][0]["at"].asString(), std::string("900:0:r_phone"));  // the client's stamp, unmodified
  CHECK_EQ(echo["marks"][0]["markedAt"].asUInt64(), h.clock.nowMs());         // the server's own clock
}

// The private lane must never become a shared one. A collaborator subscribed to the same tree sees
// the structure frames and none of the owner's marks.
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

// A mark with no stamp cannot be merged by anybody, so the frame is refused rather than acked —
// acking would drop it where nobody could watch it go.
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

// A stamp whose numbers are not numbers reaches std::stoull inside parseHlc, which THROWS. On a
// handler thread that is not a refusal, it is an unwind — so the lane reads stamps defensively.
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

// §3's skew clamp reaches this lane too: a runaway stamp would own its register for years, and the
// answer is the same non-lossy one — refuse the frame whole and hand back the server's now.
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

// The convergence property the whole lane exists for: an older stamp arriving late loses. This is
// what a reconnecting replica's re-flush does, and it must not walk a newer mark backwards.
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

// Both lanes re-graft on subscribe. Without this a reconnect heals only the structure, and a mark
// made on another device during the disconnect waits for a page reload to show up.
TEST(ws_subscribe_grafts_the_callers_overlay_alongside_the_structure) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  h.progressRepo.setStatus(TreeId{"t_priv"}, owner, NodeId{"root"}, ProgressStatus::complete, Hlc{900, 0, "r_elsewhere"}, 900);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  Json::Value graft = lastFrameOfType(*conn, "progress");
  REQUIRE_EQ(graft["marks"].size(), 1u);
  CHECK_EQ(graft["marks"][0]["node"].asString(), std::string("root"));
  CHECK_EQ(graft["marks"][0]["at"].asString(), std::string("900:0:r_elsewhere"));
}

// The overlay is the CALLER's own or it is nothing. A guest connection is not identity-less — it
// carries a guest id, the one presence announces as "Guest N" — so the graft must gate on being
// AUTHENTICATED. Gating on a non-empty user instead hands an anonymous visitor whatever overlay
// sits under that guest id, which is how a private lane quietly stops being private.
TEST(ws_subscribe_grafts_no_overlay_to_an_anonymous_visitor) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);
  h.progressRepo.setStatus(TreeId{"t_pub"}, owner, NodeId{"root"}, ProgressStatus::complete, Hlc{900, 0, "r_a"}, 900);

  auto visitor = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), visitor);
  h.collab.onMessage(visitor, subscribeFrame("t_pub"));

  for (const std::string& text : visitor->sent) CHECK(frameType(text) != std::string("progress"));
}

// A write that loses to a later stamp must not be ANNOUNCED as though it landed. Convergence
// survives either way — every replica applies the same merge — but the row and the echo announcing
// it must not be able to disagree, which is the property the receipt instant exists to hold.
// The frame is still acked: it was applied, and it lost.
TEST(ws_progress_does_not_echo_a_mark_that_lost_to_a_later_stamp) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));  // the bus only reaches a SUBSCRIBED socket
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"root", "complete", "900:0:r_desk"}}));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f2", {{"root", "none", "500:0:r_stale"}}));

  CHECK_EQ(countOfType(*conn, "progress"), 0u);  // nothing landed, so nothing is announced
  CHECK_EQ(lastFrameOfType(*conn, "progressAck")["frameId"].asString(), std::string("f2"));
  CHECK(h.progressRepo.load(TreeId{"t_priv"}, owner).marks.at(NodeId{"root"}).status == ProgressStatus::complete);
}

// …and a batch where only part of it lost announces only the part that landed.
TEST(ws_progress_echoes_the_landed_half_of_a_mixed_batch) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));  // the bus only reaches a SUBSCRIBED socket
  h.collab.onMessage(conn, progressFrame("t_priv", "f1", {{"kept", "complete", "900:0:r_desk"}}));
  conn->sent.clear();

  h.collab.onMessage(conn, progressFrame("t_priv", "f2",
                                         {{"kept", "none", "500:0:r_stale"}, {"fresh", "active", "950:0:r_stale"}}));

  Json::Value echo = lastFrameOfType(*conn, "progress");
  REQUIRE_EQ(echo["marks"].size(), 1u);
  CHECK_EQ(echo["marks"][0]["node"].asString(), std::string("fresh"));
}

// A batch is bounded like every other write on this process — four handler threads must not be
// handed an arbitrarily long list to parse, stamp and upsert one row at a time.
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

// The owner still writes to their own private tree — the gate admits exactly the reader it should.
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
  User plain = h.authRepo.createUser(Email{"sam.gold@example.com"}, "sam.gold");  // untouched default
  h.authRepo.insertSession(h.tokens.digestOf("s-plain"), plain.id, h.clock.now + 1'000'000, "", "", h.clock.now);
  h.seed("t_pub", plain.id, Visibility::public_);

  auto watcher = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), watcher);
  h.collab.onMessage(watcher, subscribeFrame("t_pub"));

  auto derived = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-plain"), derived);
  h.collab.onMessage(derived, subscribeFrame("t_pub"));

  const std::string announced = announcedName(*watcher);
  CHECK_FALSE(announced == std::string("sam.gold"));  // the address must not reach a stranger
  CHECK_FALSE(announced.empty());                     // but they are still someone
  CHECK(announced.find(' ') != std::string::npos);    // a traveller's name, two words
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

  // A resubscribe is how a client re-baselines after a gap. It still gets its own delta, but the
  // room already knows this connection: no second arrival, and it keeps the name it was given.
  h.collab.onMessage(guest, subscribeFrame("t_pub"));
  CHECK_EQ(watcher->sent.size(), seen);
  CHECK_EQ(announcedName(*watcher), announced);
  CHECK_EQ(guest->sent.size(), guestSeen + 1);  // its delta, and no second copy of the roster
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
    guests.push_back(guest);  // held open, so each newcomer collides against a full room
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
  CHECK(announced.find_first_of("0123456789") == std::string::npos);  // no id bleeding through
}

// A frame carrying more nodes than a tree may hold is the last unbounded door: joinSubgraph
// never refuses, so before this the browser path could seat any number of nodes past the very
// ceiling every command-shaped write obeys.
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

// The other half of the same gate: an ordinary browser edit — one node — still lands and acks.
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
  frame["nodes"] = toJson(state)["nodes"];  // the wire carries nodes/edges at the top level

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, dump(frame));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("subgraphAck"));
  CHECK_EQ(parse(conn->sent[0])["seq"].asInt64(), 1);
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->snapshot().nodes.size(), std::size_t{1});
}

// A frame carries four payloads and for a while only the graph was judged: 200 kinds landed on a
// legend capped at six and stayed there, frame after frame.
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

// The title register rides the same frame and was equally unjudged — a 40000-character name was
// acked and then paid for by every broadcast, save and listing after it.
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
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("the title is 40000 characters, max 200"));
  std::lock_guard<std::mutex> lock(h.rooms.strandFor(TreeId{"t_priv"}));
  CHECK_EQ(h.rooms.open(TreeId{"t_priv"})->title().value, std::string("Tree"));
}

// Two refusals, two codes: "this tree is full" and "this frame is malformed" ask different things
// of a client, and reporting a 200-character node id as a capacity problem sends the reader
// looking for room they already have.
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
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("a node id is 129 characters, max 128"));
}

// Re-privating a tree is the owner's ONLY revocation control, and it used to revoke nothing that
// was already open: read authorization was decided once, at subscribe, and the connection then sat
// on the bus receiving every later edit. A fresh subscribe was correctly refused while the socket
// beside it kept streaming the same tree's private edits, indefinitely.
TEST(ws_a_visibility_flip_drops_the_reader_it_locks_out) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_pub"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(reader->sent.size(), 2u);  // subscribed while public: the edit reached it

  {
    std::lock_guard<std::mutex> strand(h.rooms.strandFor(TreeId{"t_pub"}));
    h.rooms.setVisibility(TreeId{"t_pub"}, Visibility::private_);
  }
  // The revocation lands on the flip itself, not at the tree's next edit — a tree nobody edits
  // again would otherwise never re-check — and it says exactly what a fresh subscribe would say.
  REQUIRE_EQ(reader->sent.size(), 3u);
  CHECK_EQ(frameType(reader->sent[2]), std::string("reject"));
  CHECK_EQ(rejectCode(reader->sent[2]), std::string("no-such-tree"));
  CHECK_EQ(rejectReason(reader->sent[2]), std::string("no such tree \"t_pub\""));

  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(reader->sent.size(), 3u);  // off the bus: the private edit did not reach it
}

// The gate did not over-broaden: the owner's own subscription survives their own share flip.
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
  CHECK_EQ(countOfType(*conn, "reject"), 0u);  // nothing refused

  broadcastTo(h.bus, "t_pub");
  CHECK_EQ(countOfType(*conn, "subgraph"), 2u);  // still reading their own tree
}

// "Sign out everywhere" and closing an account reached only writes: the read path proved nothing
// after the upgrade, so a revoked session kept receiving a private tree over its open socket.
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

  h.authRepo.deleteSession(h.tokens.digestOf("s-owner"));  // signed out everywhere
  h.collab.reproveReaders();
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(countOfType(*conn, "subgraph"), 3u);  // still inside the throttle window: one more frame, at most

  h.clock.now += 61'000;  // past the one-minute re-proof, the same throttle a writer pays
  // The pass is what re-proves, on its own thread — a fan-out is a pure verdict and never a
  // database lookup, so no edit is needed here and none would help.
  h.collab.reproveReaders();
  REQUIRE_EQ(countOfType(*conn, "reject"), 1u);  // the refusal, and no edit ever ran
  CHECK_EQ(rejectCode(conn->sent.back()), std::string("no-such-tree"));

  const std::size_t afterRefusal = conn->sent.size();
  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), afterRefusal);  // dropped for good: the broadcast reached nothing
}

// Presence fans out to every co-viewer, anonymous strangers included, on any public or unlisted
// tree — and it used to carry the signed-in viewer's users.id, the system-wide primary key, to all
// of them. The name is meant to be shown; the account id never was.
TEST(ws_presence_never_puts_the_account_id_on_the_wire) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");  // signIn names the account "sam"
  h.seed("t_pub", owner, Visibility::public_);

  auto stranger = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), stranger);  // no cookie at all
  h.collab.onMessage(stranger, subscribeFrame("t_pub"));

  auto member = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), member);
  h.collab.onMessage(member, subscribeFrame("t_pub"));

  const std::string actor = announcedActor(*stranger);
  CHECK_FALSE(actor == owner.str());                        // the leak itself
  CHECK_EQ(actor, std::string("p2"));                       // a seat in this room, nothing more
  CHECK_EQ(announcedName(*stranger), std::string("sam"));   // the intended half is untouched

  // And the same seat rides the cursor frames, which is the channel that actually repeats.
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

// A room is the whole CRDT graph in memory, and every read path used to build one BEFORE asking
// whether the caller may read: a stranger's denied read materialized and pinned the private tree
// it was about to be told does not exist.
TEST(ws_a_denied_subscribe_materializes_no_room) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  REQUIRE_EQ(conn->sent.size(), 1u);
  CHECK_EQ(rejectCode(conn->sent[0]), std::string("no-such-tree"));
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_priv"}));  // nothing was loaded on the way to the refusal
  CHECK_EQ(h.rooms.openRooms(), std::size_t{0});
}

// The same rule on the write path: a frame nobody is allowed to write must not load the tree
// either, or an authenticated stranger could pin every id they can name.
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

// The upgrade is where a cookie is spent, and it is outside the CORS policy that guards every
// other cookie-bearing door: a cross-site page's socket rode the victim's cookie and was served
// the full private delta, stopped only by SameSite=Lax — an attribute this server does not own.
TEST(ws_an_upgrade_from_an_unlisted_origin_is_refused) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto evil = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner", "http://evil.example.com"), evil);
  CHECK_FALSE(evil->connected());  // closed at the handshake, before a frame is ever read

  h.collab.onMessage(evil, subscribeFrame("t_priv"));
  CHECK_EQ(evil->sent.size(), 0u);  // and it is served nothing even if a frame arrives anyway
}

// The two clients that must keep working: the app itself, and everything that is not a browser.
// Only a browser sends Origin, and only a browser can be aimed at this server by someone else.
TEST(ws_an_upgrade_from_the_app_or_from_no_origin_at_all_is_served) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto browser = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner", "https://windmill.works"), browser);
  h.collab.onMessage(browser, subscribeFrame("t_priv"));
  REQUIRE_EQ(countOfType(*browser, "subgraph"), 1u);
  CHECK_EQ(countOfType(*browser, "reject"), 0u);

  auto script = std::make_shared<FakeSocket>();  // curl, a device, the MCP tooling: no Origin
  h.collab.onOpen(h.upgrade("s-owner"), script);
  h.collab.onMessage(script, subscribeFrame("t_priv"));
  // Its own delta, plus the roster of whoever is already in the room — never a refusal.
  REQUIRE(script->sent.size() >= 1u);
  for (const std::string& text : script->sent) CHECK_FALSE(frameType(text) == "reject");
  CHECK(std::any_of(script->sent.begin(), script->sent.end(),
                    [](const std::string& text) { return frameType(text) == "subgraph"; }));
}

// An HLC counter past what 64 bits hold threw out of the frame decoder, into onMessage's catch,
// which logged it and answered nothing at all — so the client's in-flight entry for that frameId
// leaked forever and its banked edits were stranded with nothing on screen saying so.
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

// The same stamp in a subscribe's version vector: a subscribe that never answers is a client that
// waits forever on a socket it believes is healthy.
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

// The gate was total over the BUS and blind to the channel that actually carries a person's live
// activity: PresenceHub::flush fans cursors and selections straight to its own roster at 20 Hz,
// never through WsPresenceBus. So on a tree nobody was editing — no broadcast to gate, no share
// flip to resweep — a reader whose session had been revoked went on watching a peer's cursor and
// the node ids they selected, indefinitely. Nothing in this test edits anything.
TEST(ws_presence_stops_reaching_a_revoked_reader_on_a_tree_nobody_is_editing) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.addSession("s-owner-2", owner);  // the same account, a second device
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
  REQUIRE_EQ(presenceFrames(*tab2), std::size_t{1});  // it is a legitimate reader, for now

  h.authRepo.deleteSession(h.tokens.digestOf("s-owner-2"));
  h.clock.now += 61'000;
  h.collab.reproveReaders();  // the clock, not an edit: there is no edit anywhere in this test

  const std::size_t before = presenceFrames(*tab2);
  h.collab.onMessage(tab1, dump(cursor));
  h.presence.flush();
  CHECK_EQ(presenceFrames(*tab2), before);  // the cursor and the selection stop at the roster
  CHECK(std::any_of(tab2->sent.begin(), tab2->sent.end(),
                    [](const std::string& text) { return frameType(text) == "reject"; }));
  // And the peer it was watching is told it left, so no stale cursor is left painted.
  CHECK(std::any_of(tab1->sent.begin(), tab1->sent.end(), [](const std::string& text) {
    return frameType(text) == "peer" && parse(text).get("event", "").asString() == "leave";
  }));
}

// Deleting a tree is the strongest revocation the product has, and the gate was structurally
// unable to see it: accessOf answers from the live room, and remove() retired the row without
// touching it. So a soft-deleted tree whose room was still resident kept reading as its old self —
// and open() answers a resident room without ever consulting the row, so a brand-new anonymous
// socket was served the whole lattice of a tree its owner had deleted.
TEST(ws_deleting_a_tree_drops_its_readers_and_refuses_a_fresh_one) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_pub", owner, Visibility::public_);

  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_pub"));
  REQUIRE_EQ(reader->sent.size(), 1u);
  CHECK_FALSE(frameType(reader->sent[0]) == "reject");
  CHECK(h.rooms.isOpen(TreeId{"t_pub"}));  // resident, which is the whole hazard

  CHECK(h.trees_registry.remove(TreeId{"t_pub"}, owner) == TreeRegistry::Removal::deleted);

  REQUIRE_EQ(reader->sent.size(), 2u);
  CHECK_EQ(rejectCode(reader->sent[1]), std::string("no-such-tree"));  // dropped on the delete
  CHECK_FALSE(h.rooms.isOpen(TreeId{"t_pub"}));                        // and the room is gone

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
