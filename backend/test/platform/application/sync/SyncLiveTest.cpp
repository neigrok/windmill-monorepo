#include "platform/application/sync/SyncLive.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/ports/ChangeFeed.h"

#include "test/platform/application/sync/SyncFakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// §6.8 and §9.5 over the fakes: the exact frames each socket receives as real admissions commit, and when each
// subscription ends.

using namespace wm;
using namespace wm::sync;

namespace {

// Canonical server state with each scope's digest summed from its rows (§6.12).
Json::Value withDigests(Json::Value state) {
  for (const std::string& key : state["scopes"].getMemberNames()) {
    const Json::Value& rows = state["rows"][key];
    state["scopes"][key]["digest"] = scopeDigest(std::vector<Json::Value>(rows.begin(), rows.end())).hex();
  }
  return state;
}

// A's board b_00000001, whose tree's meta holds `visibility`, and A's and B's overlays of it, each with a mark.
Json::Value boardState(const std::string& visibility) {
  Json::Value state = parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}},
      "scopes": {
        "acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {}},
        "tree:b_00000001": {"kind": "tree", "owner": "A", "state": "alive", "seq": 1, "counters": {}, "governedBy": "acct:A/probe#board#b_00000001"},
        "acct:A/overlay/b_00000001": {"kind": "overlay", "owner": "A", "state": "alive", "seq": 1, "counters": {}, "governedBy": "tree:b_00000001"},
        "acct:B/overlay/b_00000001": {"kind": "overlay", "owner": "B", "state": "alive", "seq": 1, "counters": {}, "governedBy": "tree:b_00000001"}},
      "rows": {
        "acct:A/probe": [{"t": "board", "id": "b_00000001", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa", "seq": 1, "rc": 1000, "ru": 1000}],
        "tree:b_00000001": [{"t": "meta", "id": "meta", "f": {"title": ["Oak", "2000:0:r_aaaaaaaaaaaa"], "visibility": [null, "2500:0:srv"]}, "seq": 1, "rc": 1000, "ru": 1000}],
        "acct:A/overlay/b_00000001": [{"t": "mark", "id": "oak", "f": {"done": [true, "2600:0:r_aaaaaaaaaaaa"]}, "seq": 1, "rc": 1000, "ru": 1000}],
        "acct:B/overlay/b_00000001": [{"t": "mark", "id": "oak", "f": {"done": [true, "2600:0:r_bbbbbbbbbbbb"]}, "seq": 1, "rc": 1000, "ru": 1000}]}})");
  state["rows"]["tree:b_00000001"][0]["f"]["visibility"][0] = visibility;
  return withDigests(state);
}

// One server-origin admission of `account` at 1 000 000 ms: the server mints every null stamp.
void admitAsServer(Admission& admission, const UserId& account, const std::string& intent) {
  const AdmitOutcome outcome = admission.admit(ServerOrigin{account, std::nullopt}, parseJson(intent), 1'000'000);
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(std::get<Admitted>(outcome).result["s"].asString(), "ok");
}

// A store whose next scope read runs `then` once the row is read: a commit that lands after a sub's snapshot and
// before its decision.
class AfterScopeRead final : public fake::ForwardingStore {
public:
  using ForwardingStore::ForwardingStore;

  std::optional<ScopeRow> scope(SyncTxn& txn, const ScopeKey& key, RowLock lock) override {
    std::optional<ScopeRow> row = ForwardingStore::scope(txn, key, lock);
    if (then) std::exchange(then, nullptr)();
    return row;
  }

  std::function<void()> then;
};

}

TEST(sync_live_sends_the_owner_of_a_product_scope_each_change_with_its_rows) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));

  live.subscribe(*ann, parseJson(R"(["self/probe"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "self/probe", "d": [{"t": "card", "id": "card0001", "born": null,
      "life": ["alive", null], "f": {"title": ["First", null]}}]})");

  const Json::Value card = parseJson(R"({"t": "card", "id": "card0001", "life": ["alive", "1000000:0:srv"], "born": "1000000:0:srv",
      "f": {"title": ["First", "1000000:0:srv"]}, "seq": 1, "rc": 1000000, "ru": 1000000})");
  Json::Value expected = parseJson(R"([{"op": "change", "scope": "self/probe", "epoch": "ep-1", "seq": 1, "rows": []}])");
  expected[0]["digest"] = scopeDigest({card}).hex();
  expected[0]["rows"].append(card);
  CHECK_EQ(jcs(ann->frames), jcs(expected));
}

TEST(sync_live_leaves_the_rows_out_of_a_change_frame_past_live_inline_bytes) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  SyncLive live(world.catalog(), world.store(), Limits{.liveInlineBytes = 16});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));

  live.subscribe(*ann, parseJson(R"(["self/probe"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "self/probe", "d": [{"t": "card", "id": "card0001", "born": null,
      "life": ["alive", null], "f": {"title": ["First", null]}}]})");

  const Json::Value card = parseJson(R"({"t": "card", "id": "card0001", "life": ["alive", "1000000:0:srv"], "born": "1000000:0:srv",
      "f": {"title": ["First", "1000000:0:srv"]}, "seq": 1, "rc": 1000000, "ru": 1000000})");
  Json::Value expected = parseJson(R"([{"op": "change", "scope": "self/probe", "epoch": "ep-1", "seq": 1}])");
  expected[0]["digest"] = scopeDigest({card}).hex();
  CHECK_EQ(jcs(ann->frames), jcs(expected));
}

TEST(sync_live_answers_another_accounts_private_tree_exactly_as_an_absent_tree_and_an_unresolvable_ref) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(boardState("private"));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto bob = std::make_shared<fake::RecordingSocket>();
  const auto guest = std::make_shared<fake::RecordingSocket>();
  live.open(bob, world.account("B"));
  live.open(guest, std::nullopt);

  live.subscribe(*bob, parseJson(R"(["tree/b_00000001", "self/overlay/b_00000001", "tree/b_0000000f", "self/overlay/b_0000000f",
      "device/probe", "self/nope", "tree/B_00000001", "self/overlay/B_00000001"])"));
  live.subscribe(*guest, parseJson(R"(["tree/b_00000001", "self/probe"])"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001", 7])"));
  live.subscribe(*bob, parseJson(R"({"scopes": ["tree/b_00000001"]})"));
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000001", "d": [{"t": "meta", "id": "meta", "f": {"title": ["Pine", null]}}]})");

  CHECK_EQ(jcs(bob->frames), jcs(parseJson(R"([
      {"op": "not-found", "scope": "tree/b_00000001"}, {"op": "not-found", "scope": "self/overlay/b_00000001"},
      {"op": "not-found", "scope": "tree/b_0000000f"}, {"op": "not-found", "scope": "self/overlay/b_0000000f"},
      {"op": "not-found", "scope": "device/probe"}, {"op": "not-found", "scope": "self/nope"},
      {"op": "not-found", "scope": "tree/B_00000001"}, {"op": "not-found", "scope": "self/overlay/B_00000001"}])")));
  CHECK_EQ(jcs(guest->frames), jcs(parseJson(R"([{"op": "not-found", "scope": "tree/b_00000001"}, {"op": "not-found", "scope": "self/probe"}])")));
}

TEST(sync_live_ends_a_strangers_tree_and_overlay_subscriptions_when_the_owner_makes_the_tree_private) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(boardState("public"));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  const auto bob = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));
  live.open(bob, world.account("B"));

  live.subscribe(*ann, parseJson(R"(["tree/b_00000001"])"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001", "self/overlay/b_00000001"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000001", "d": [{"t": "meta", "id": "meta", "f": {"visibility": ["private", null]}}]})");
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000001", "d": [{"t": "meta", "id": "meta", "f": {"title": ["Pine", null]}}]})");

  CHECK_EQ(jcs(bob->frames), jcs(parseJson(R"([{"op": "not-found", "scope": "self/overlay/b_00000001"}, {"op": "not-found", "scope": "tree/b_00000001"}])")));
  const Json::Value privateMeta = parseJson(R"({"t": "meta", "id": "meta", "f": {"title": ["Oak", "2000:0:r_aaaaaaaaaaaa"],
      "visibility": ["private", "1000000:0:srv"]}, "seq": 2, "rc": 1000, "ru": 1000000})");
  const Json::Value renamedMeta = parseJson(R"({"t": "meta", "id": "meta", "f": {"title": ["Pine", "1000000:1:srv"],
      "visibility": ["private", "1000000:0:srv"]}, "seq": 3, "rc": 1000, "ru": 1000000})");
  Json::Value expected = parseJson(R"([{"op": "change", "scope": "tree/b_00000001", "epoch": "ep-1", "seq": 2, "rows": []},
      {"op": "change", "scope": "tree/b_00000001", "epoch": "ep-1", "seq": 3, "rows": []}])");
  expected[0]["digest"] = scopeDigest({privateMeta}).hex();
  expected[0]["rows"].append(privateMeta);
  expected[1]["digest"] = scopeDigest({renamedMeta}).hex();
  expected[1]["rows"].append(renamedMeta);
  CHECK_EQ(jcs(ann->frames), jcs(expected));
}

TEST(sync_live_answers_a_board_death_with_gone_to_its_owner_and_not_found_to_a_stranger) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(boardState("public"));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  const auto bob = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));
  live.open(bob, world.account("B"));

  live.subscribe(*ann, parseJson(R"(["self/probe", "tree/b_00000001", "self/overlay/b_00000001"])"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001", "self/overlay/b_00000001"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "self/probe", "d": [{"t": "board", "id": "b_00000001", "born": "2000:0:r_aaaaaaaaaaaa",
      "life": ["dead", null]}]})");
  live.subscribe(*ann, parseJson(R"(["tree/b_00000001", "self/overlay/b_00000001"])"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001", "self/overlay/b_00000001"])"));

  Json::Value annExpected = parseJson(R"([
      {"op": "change", "scope": "self/probe", "epoch": "ep-1", "seq": 2,
       "rows": [{"t": "board", "id": "b_00000001", "life": ["dead", "1000000:0:srv"], "born": "2000:0:r_aaaaaaaaaaaa", "seq": 2}]},
      {"op": "gone", "scope": "self/overlay/b_00000001"}, {"op": "gone", "scope": "tree/b_00000001"},
      {"op": "gone", "scope": "tree/b_00000001"}, {"op": "gone", "scope": "self/overlay/b_00000001"}])");
  annExpected[0]["digest"] = Digest256{}.hex();
  CHECK_EQ(jcs(ann->frames), jcs(annExpected));
  CHECK_EQ(jcs(bob->frames), jcs(parseJson(R"([
      {"op": "not-found", "scope": "self/overlay/b_00000001"}, {"op": "not-found", "scope": "tree/b_00000001"},
      {"op": "not-found", "scope": "tree/b_00000001"}, {"op": "not-found", "scope": "self/overlay/b_00000001"}])")));
}

TEST(sync_live_sends_one_scopes_frames_in_seq_order_while_its_writes_race) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(withDigests(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0},
      "scopes": {"acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {"card": 1}}},
      "rows": {"acct:A/probe": [{"t": "card", "id": "card0001", "life": ["alive", "1000:0:r_aaaaaaaaaaaa"], "born": "1000:0:r_aaaaaaaaaaaa",
        "f": {"title": ["Card", "1000:0:r_aaaaaaaaaaaa"]}, "seq": 1, "rc": 1000, "ru": 1000}]}})")));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));
  live.subscribe(*ann, parseJson(R"(["self/probe"])"));

  std::vector<std::thread> writers;
  for (int writer = 0; writer < 5; ++writer) {
    writers.emplace_back([&admission, account = world.account("A"), writer] {
      BlockingThread::Mark blocking;
      for (int write = 0; write < 10; ++write) {
        Json::Value intent = parseJson(R"({"scope": "self/probe", "d": [{"t": "card", "id": "card0001", "born": "1000:0:r_aaaaaaaaaaaa",
            "f": {"title": [null, null]}}]})");
        intent["d"][0]["f"]["title"][0] = "w" + std::to_string(writer) + "n" + std::to_string(write);
        admission.admit(ServerOrigin{account, std::nullopt}, intent, 1'000'000);
      }
    });
  }
  for (std::thread& writer : writers) writer.join();

  Json::Value sent(Json::arrayValue);
  Json::Value expected(Json::arrayValue);
  for (const Json::Value& frame : ann->frames) {
    Json::Value head(Json::arrayValue);
    head.append(frame["op"]);
    head.append(frame["scope"]);
    head.append(frame["seq"]);
    sent.append(head);
  }
  for (int seq = 2; seq <= 51; ++seq) expected.append(parseJson("[\"change\", \"self/probe\", " + std::to_string(seq) + "]"));
  CHECK_EQ(jcs(sent), jcs(expected));
}

TEST(sync_live_sign_out_ends_every_subscription_that_needs_an_account_and_keeps_a_public_tree) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Json::Value state = boardState("public");
  state["scopes"]["tree:b_00000002"] = parseJson(R"({"kind": "tree", "owner": "A", "state": "alive", "seq": 1, "counters": {},
      "governedBy": "acct:A/probe#board#b_00000002"})");
  state["rows"]["acct:A/probe"].append(parseJson(R"({"t": "board", "id": "b_00000002", "life": ["alive", "2000:1:r_aaaaaaaaaaaa"],
      "born": "2000:1:r_aaaaaaaaaaaa", "seq": 1, "rc": 1000, "ru": 1000})"));
  state["rows"]["tree:b_00000002"].append(parseJson(R"({"t": "meta", "id": "meta", "f": {"title": ["Elm", "2000:1:r_aaaaaaaaaaaa"],
      "visibility": ["private", "2500:0:srv"]}, "seq": 1, "rc": 1000, "ru": 1000})"));
  world.seed(withDigests(state));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));

  live.subscribe(*ann, parseJson(R"(["self/probe", "self/overlay/b_00000001", "tree/b_00000001", "tree/b_00000002"])"));
  live.signOut(*ann);
  live.subscribe(*ann, parseJson(R"(["self/probe"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "self/probe", "d": [{"t": "board", "id": "b_00000003", "born": null,
      "life": ["alive", null]}]})");
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000002", "d": [{"t": "meta", "id": "meta", "f": {"title": ["Ash", null]}}]})");
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000001", "d": [{"t": "meta", "id": "meta", "f": {"title": ["Pine", null]}}]})");

  const Json::Value renamedMeta = parseJson(R"({"t": "meta", "id": "meta", "f": {"title": ["Pine", "1000000:2:srv"],
      "visibility": ["public", "2500:0:srv"]}, "seq": 2, "rc": 1000, "ru": 1000000})");
  Json::Value expected = parseJson(R"([
      {"op": "not-found", "scope": "self/overlay/b_00000001"}, {"op": "not-found", "scope": "self/probe"},
      {"op": "not-found", "scope": "tree/b_00000002"}, {"op": "not-found", "scope": "self/probe"},
      {"op": "change", "scope": "tree/b_00000001", "epoch": "ep-1", "seq": 2, "rows": []}])");
  expected[4]["digest"] = scopeDigest({renamedMeta}).hex();
  expected[4]["rows"].append(renamedMeta);
  CHECK_EQ(jcs(ann->frames), jcs(expected));
}

TEST(sync_live_sends_a_closed_socket_nothing_more) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(boardState("public"));
  SyncLive live(world.catalog(), world.store(), Limits{});
  Admission admission(world.catalog(), world.store(), live, world.clock(), world.failures);
  const auto ann = std::make_shared<fake::RecordingSocket>();
  const auto bob = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));
  live.open(bob, world.account("B"));

  live.subscribe(*ann, parseJson(R"(["self/probe", "tree/b_00000001"])"));
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001"])"));
  live.close(*ann);
  live.subscribe(*ann, parseJson(R"(["self/probe", "tree/b_0000000f"])"));
  admitAsServer(admission, world.account("A"), R"({"scope": "self/probe", "d": [{"t": "board", "id": "b_00000003", "born": null,
      "life": ["alive", null]}]})");
  admitAsServer(admission, world.account("A"), R"({"scope": "tree/b_00000001", "d": [{"t": "meta", "id": "meta", "f": {"title": ["Pine", null]}}]})");

  const Json::Value renamedMeta = parseJson(R"({"t": "meta", "id": "meta", "f": {"title": ["Pine", "1000000:1:srv"],
      "visibility": ["public", "2500:0:srv"]}, "seq": 2, "rc": 1000, "ru": 1000000})");
  Json::Value expected = parseJson(R"([{"op": "change", "scope": "tree/b_00000001", "epoch": "ep-1", "seq": 2, "rows": []}])");
  expected[0]["digest"] = scopeDigest({renamedMeta}).hex();
  expected[0]["rows"].append(renamedMeta);
  CHECK_EQ(jcs(ann->frames), "[]");
  CHECK_EQ(jcs(bob->frames), jcs(expected));
}

TEST(sync_live_decides_a_sub_by_what_was_published_while_its_snapshot_was_read) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(boardState("public"));
  AfterScopeRead store(world.store());
  SyncLive live(world.catalog(), store, Limits{});
  const auto ann = std::make_shared<fake::RecordingSocket>();
  const auto bob = std::make_shared<fake::RecordingSocket>();
  live.open(ann, world.account("A"));
  live.open(bob, world.account("B"));
  const ScopeKey tree = ScopeKey::tree("b_00000001");

  store.then = [&live, &world, &tree] {
    live.publish(CommittedChange{"ep-1", {ScopeChange{.key = tree, .owner = world.account("A"), .open = false, .seq = 2}}, {}});
  };
  live.subscribe(*bob, parseJson(R"(["tree/b_00000001"])"));
  store.then = [&live, &tree] { live.publish(CommittedChange{"ep-1", {}, {tree}}); };
  live.subscribe(*ann, parseJson(R"(["tree/b_00000001"])"));

  CHECK_EQ(jcs(bob->frames), jcs(parseJson(R"([{"op": "not-found", "scope": "tree/b_00000001"}])")));
  CHECK_EQ(jcs(ann->frames), jcs(parseJson(R"([{"op": "gone", "scope": "tree/b_00000001"}])")));
}
