#include "products/roadmap/adapters/ws/Collab.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "platform/domain/Access.h"
#include "products/roadmap/domain/Subgraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <trantor/net/InetAddress.h>

#include <chrono>
#include <memory>
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
  Collab collab{rooms, ops, bus, progress, auth, presence, clock};

  UserId signIn(const std::string& secret, const std::string& emailAddr) {
    User user = authRepo.createUser(Email{emailAddr}, "sam");
    authRepo.insertSession(tokens.digestOf(secret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void seed(const char* id, const UserId& owner, Visibility visibility) {
    trees.byId[id] = StoredTree{GraphState{}, LegendState{}, {"Tree", {}}, 0, owner, visibility};
  }

  drogon::HttpRequestPtr upgrade(const std::string& session) {
    auto req = drogon::HttpRequest::newHttpRequest();
    if (!session.empty()) req->addCookie("wm_session", session);
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

std::string rejectReason(const std::string& text) { return parse(text).get("reason", "").asString(); }

// Broadcast one live frame to whoever is subscribed to `tree` — the probe for "is this
// connection on the bus?".
void broadcastTo(WsPresenceBus& bus, const char* tree) {
  Subgraph frame;
  frame.treeId = TreeId{tree};
  bus.broadcastSubgraph(TreeId{tree}, 2, frame);
}

std::string frameType(const std::string& text) { return parse(text).get("t", "").asString(); }

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

  CHECK_EQ(conn->sent.size(), 1u);
  CHECK_FALSE(frameType(conn->sent[0]) == "reject");  // the delta, not a rejection

  broadcastTo(h.bus, "t_priv");
  CHECK_EQ(conn->sent.size(), 2u);  // subscribed: the live broadcast reached it
}

TEST(ws_anon_on_a_private_tree_is_rejected_and_never_joins_the_bus) {
  Harness h;
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);  // no cookie — an anonymous guest
  h.collab.onMessage(conn, subscribeFrame("t_priv"));

  CHECK_EQ(conn->sent.size(), 1u);
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

  CHECK_EQ(conn->sent.size(), 1u);
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

  CHECK_EQ(conn->sent.size(), 1u);
  CHECK_FALSE(frameType(conn->sent[0]) == "reject");

  broadcastTo(h.bus, "t_shared");
  CHECK_EQ(conn->sent.size(), 2u);  // subscribed
}

TEST(ws_subscribe_to_an_absent_tree_is_rejected) {
  Harness h;
  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), conn);
  h.collab.onMessage(conn, subscribeFrame("t_ghost"));

  CHECK_EQ(conn->sent.size(), 1u);
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

  CHECK_EQ(onPrivate->sent.size(), 1u);
  CHECK_EQ(frameType(onPrivate->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(onPrivate->sent[0]), std::string("no such tree \"t_priv\""));
  CHECK_EQ(rejectReason(onAbsent->sent[0]), std::string("no such tree \"t_ghost\""));
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

  CHECK_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(conn->sent[0]), std::string("this tree belongs to another account"));
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

  CHECK_EQ(conn->sent.size(), 1u);
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

  CHECK_EQ(conn->sent.size(), 1u);
  CHECK_EQ(frameType(conn->sent[0]), std::string("reject"));
  CHECK_EQ(rejectReason(conn->sent[0]),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, "
                       "or fork it into a roadmap of your own"));
  CHECK_FALSE(h.trees.byId["t_demo"].owner.has_value());  // still nobody's
  CHECK(h.trees.byId["t_demo"] == before);                // and byte-identical: nothing was written
  CHECK(h.ops.byTree["t_demo"].empty());                  // not even an op logged

  // Still readable by the world — the demo is not broken by being unwritable.
  auto reader = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade(""), reader);
  h.collab.onMessage(reader, subscribeFrame("t_demo"));
  CHECK_EQ(reader->sent.size(), 1u);
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
}

// The owner still writes to their own private tree — the gate admits exactly the reader it should.
TEST(ws_owner_writes_to_their_own_private_tree_and_is_acked) {
  Harness h;
  UserId owner = h.signIn("s-owner", "owner@example.com");
  h.seed("t_priv", owner, Visibility::private_);

  auto conn = std::make_shared<FakeSocket>();
  h.collab.onOpen(h.upgrade("s-owner"), conn);
  h.collab.onMessage(conn, writeFrame("t_priv"));

  CHECK_EQ(conn->sent.size(), 1u);
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
