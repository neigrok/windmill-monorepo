#include "platform/application/sync/Admission.h"

#include "platform/application/WorkerPool.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"

#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <string>
#include <variant>

// What the golden corpus does not pin about Admission: the text merge's work bound, a base rev past every seq,
// a string holding U+0000, and a replica bound to another account by the time its intent is admitted.

using namespace wm;
using namespace wm::sync;

namespace {

// A's overlay of tree b_00000001 with mark oak's memo "red blue" at rev 1, and A's replica bound at n 0.
Json::Value markedOverlay() {
  return parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}},
      "scopes": {
        "acct:A/overlay/b_00000001": {"kind": "overlay", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "e20fc4bfe5b8860ea5b055a09220f94960b480fa341720dda2ea44dd4e50b84d", "governedBy": "tree:b_00000001"},
        "acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "ebc41c27fd23cc61823a43f3362722bf92a6ffea3191e96d1f20cf4b42c3e9e8"},
        "tree:b_00000001": {"kind": "tree", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "34cfa50c64a4ac819036783f44030d4905a8d034c662757d08ef0a00e7eb3d1a", "governedBy": "acct:A/probe#board#b_00000001"}},
      "rows": {
        "acct:A/overlay/b_00000001": [{"t": "mark", "id": "oak", "x": {"memo": {"text": "red blue", "rev": 1, "merged": false}},
            "seq": 1, "rc": 1000, "ru": 1000}],
        "acct:A/probe": [{"t": "board", "id": "b_00000001", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa",
            "seq": 1, "rc": 1000, "ru": 1000}],
        "tree:b_00000001": [{"t": "tag", "id": "oak", "life": ["alive", "2100:0:r_aaaaaaaaaaaa"], "born": "2100:0:r_aaaaaaaaaaaa",
            "seq": 1, "rc": 1000, "ru": 1000}]},
      "replicas": {"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 0}}})");
}

// Mark oak's memo write in A's overlay.
Json::Value memoIntent(const Json::Value& write) {
  Json::Value intent = parseJson(R"({"scope": "self/overlay/b_00000001", "d": [{"t": "mark", "id": "oak", "x": {}}]})");
  intent["d"][0]["x"]["memo"] = write;
  return intent;
}

// Intent 1 of A's replica, admitted at serverNow 1000000.
AdmitOutcome admitFirst(test::SyncWorld& world, Admission& admission, const Json::Value& intent) {
  return admission.admit(ReplicaOrigin{world.account("A"), "rp_0000000000000000000000000000000a", 1, intentDigest(intent)}, intent,
                         1'000'000);
}

// The seeded state with intent 1 answered `result` and nothing else changed.
Json::Value answeredOnly(const Json::Value& seeded, const Json::Value& intent, const Json::Value& result) {
  Json::Value expected = seeded;
  expected["replicas"]["rp_0000000000000000000000000000000a"]["lastN"] = 1;
  Json::Value stored(Json::objectValue);
  stored["n"] = 1;
  stored["digest"] = intentDigest(intent).hex();
  stored["result"] = result;
  stored["faults"] = 0;
  expected["results"]["rp_0000000000000000000000000000000a"].append(stored);
  return expected;
}

}

TEST(admission_refuses_a_text_merge_past_the_work_bound_too_large_and_reports_nothing) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  std::string base;
  std::string mine;
  for (int i = 0; i < 1500; ++i) {
    base += "a ";
    mine += "b ";
  }
  Json::Value write(Json::objectValue);
  write["text"] = mine;
  write["base"]["text"] = base;
  const Json::Value intent = memoIntent(write);

  const AdmitOutcome outcome = admitFirst(world, admission, intent);

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "too-large"})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, intent, refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_answers_base_unknown_for_a_base_rev_past_every_seq) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const Json::Value intent = memoIntent(parseJson(R"({"text": "red", "base": {"rev": 1e300}})"));

  const AdmitOutcome outcome = admitFirst(world, admission, intent);

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "base-unknown"})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, intent, refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_refuses_a_string_holding_u0000_invalid_wherever_it_sits) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  Json::Value inText(Json::objectValue);
  inText["text"] = std::string("red\0blue", 8);
  inText["base"]["rev"] = 1;
  Json::Value inBase(Json::objectValue);
  inBase["text"] = "red";
  inBase["base"]["text"] = std::string("\0", 1);

  const AdmitOutcome textOutcome = admitFirst(world, admission, memoIntent(inText));
  world.seed(markedOverlay());
  const AdmitOutcome baseOutcome = admitFirst(world, admission, memoIntent(inBase));

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "invalid"})");
  REQUIRE(std::holds_alternative<Admitted>(textOutcome));
  CHECK_EQ(jcs(std::get<Admitted>(textOutcome).result), jcs(refused));
  REQUIRE(std::holds_alternative<Admitted>(baseOutcome));
  CHECK_EQ(jcs(std::get<Admitted>(baseOutcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, memoIntent(inBase), refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_leaves_an_intent_of_a_replica_now_bound_to_another_account_unanswered) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Json::Value state = markedOverlay();
  state["replicas"]["rp_0000000000000000000000000000000a"]["account"] = "B";
  world.seed(state);
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);

  const AdmitOutcome admissible = admitFirst(world, admission, memoIntent(parseJson(R"({"text": "red", "base": {"rev": 1}})")));
  const AdmitOutcome refusable = admitFirst(world, admission, memoIntent(parseJson(R"({"text": "red", "base": {"rev": "one"}})")));

  CHECK(std::holds_alternative<AlreadyAnswered>(admissible));
  CHECK(std::holds_alternative<AlreadyAnswered>(refusable));
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
  CHECK(world.feed.published.empty());
}
