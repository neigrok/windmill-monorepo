#include "test/products/gym/sync/GymDoorFixture.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/application/WorkerPool.h"
#include "test/testing.h"

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <variant>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

// A turn's records as a phone's first push holds them: the conversation, the lifter's question and the Coach message in `state`.
void turn(Harness& h, const std::string& coachState) {
  Json::Value title(Json::objectValue);
  title["title"] = "How heavy today?";
  Json::Value question(Json::objectValue);
  question["threadId"] = "thread000001";
  question["role"] = "lifter";
  question["text"] = "How heavy today?";
  question["at"] = Json::UInt64(1'760'000'000'006);
  Json::Value answer(Json::objectValue);
  answer["threadId"] = "thread000001";
  answer["role"] = "coach";
  answer["replica"] = "rp_0000000000000000000000000000000a";
  answer["state"] = coachState;
  answer["text"] = "Add 2.5";
  answer["at"] = Json::UInt64(1'760'000'000'006);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("thread", "thread000001", title, true),
                                      GymDoor::delta("message", "lifter000001", question, true),
                                      GymDoor::delta("message", "turn00000001", answer, true)}));
}

// The message whole, as a replica pulls it.
Json::Value pulled(const UserId& account, const std::string& messageId) {
  sync::PgSyncStore store{pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::snapshot);
  for (const sync::Row& row : sync::productCatalog()->store("message").feed(*txn, sync::ScopeKey::product(account, "gym"), sync::FeedQuery{})) {
    const Json::Value wire = row.toJson();
    if (wire["id"].asString() == messageId) return wire;
  }
  return Json::Value();
}

std::uint64_t scopeSeq(const UserId& account) {
  sync::PgSyncStore store{pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::snapshot);
  return store.scope(*txn, sync::ScopeKey::product(account, "gym"), sync::RowLock::none)->seq;
}

// The phone named on the message writes under its own stamp through the engine's replica admission, the door to a push.
Json::Value phoneWrites(Harness& h, std::uint64_t n, const std::string& stamp, const Json::Value& fields) {
  const auto catalog = sync::productCatalog();
  sync::PgSyncStore store{pool(), sync::Limits{}.lockTimeoutMs};
  sync::NullChangeFeed feed;
  sync::ServerClock stamps;
  sync::Admission admission{*catalog, store, feed, stamps, h.failures};
  Json::Value delta = GymDoor::delta("message", "turn00000001", fields);
  delta["born"] = pulled(h.user, "turn00000001")["born"];
  for (const auto& field : delta["f"].getMemberNames()) delta["f"][field][1] = stamp;
  Json::Value built = GymDoor::intent();
  built["d"].append(delta);
  BlockingThread::Mark blocking;
  const auto outcome = admission.admit(sync::ReplicaOrigin{h.user, "rp_0000000000000000000000000000000a", n, sync::intentDigest(built)}, built, h.clock.now);
  const auto* admitted = std::get_if<sync::Admitted>(&outcome);
  if (!admitted) throw std::runtime_error("the push was not taken");
  return admitted->result;
}

}

TEST(the_server_interrupts_a_running_coach_message_writing_its_state_and_nothing_else) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "running");
  Json::Value expected = pulled(h.user, "turn00000001");

  CHECK(h.door.interrupt(h.user, "turn00000001"));

  Json::Value message = pulled(h.user, "turn00000001");
  CHECK_EQ(message["f"]["state"][0].asString(), std::string("interrupted"));
  CHECK_EQ(message["seq"].asUInt64(), scopeSeq(h.user));
  for (Json::Value* row : {&expected, &message}) {
    row->removeMember("seq");
    (*row)["f"].removeMember("state");
  }
  CHECK_EQ(dump(message), dump(expected));
  CHECK(scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(a_coach_message_that_ended_is_left_as_it_stands) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  for (const std::string state : {"completed", "declined", "failed", "stopped", "interrupted"}) {
    Harness h;
    turn(h, state);
    const Json::Value before = pulled(h.user, "turn00000001");
    const std::uint64_t seq = scopeSeq(h.user);

    CHECK_FALSE(h.door.interrupt(h.user, "turn00000001"));

    CHECK_EQ(dump(pulled(h.user, "turn00000001")), dump(before));
    CHECK_EQ(scopeSeq(h.user), seq);
    CHECK(scopeConsistent(h.user));
    CHECK(h.failures.messages.empty());
  }
}

TEST(an_interrupt_with_no_running_coach_message_under_the_id_writes_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "running");
  const Json::Value lifter = pulled(h.user, "lifter000001");
  const Json::Value coach = pulled(h.user, "turn00000001");

  CHECK_FALSE(h.door.interrupt(h.user, "turn00000009"));
  CHECK_FALSE(h.door.interrupt(h.user, "lifter000001"));
  CHECK_FALSE(h.door.interrupt(h.other, "turn00000001"));

  CHECK_EQ(dump(pulled(h.user, "lifter000001")), dump(lifter));
  CHECK_EQ(dump(pulled(h.user, "turn00000001")), dump(coach));

  h.kill(h.user, "thread", "thread000001");
  CHECK_FALSE(h.door.interrupt(h.user, "turn00000001"));
  CHECK(pulled(h.user, "turn00000001").isNull());
  CHECK(scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(a_late_phone_ending_beats_the_servers_interrupted_whatever_its_stamp) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "running");
  const std::string older = std::to_string(h.clock.now + 60'000) + ":0:r_phone000001";
  h.clock.now += 11 * 60'000;
  CHECK(h.door.interrupt(h.user, "turn00000001"));
  CHECK(pulled(h.user, "turn00000001")["f"]["state"][1].asString() > older);

  Json::Value ending(Json::objectValue);
  ending["state"] = "completed";
  ending["text"] = "Add 2.5 kg.";
  CHECK_EQ(phoneWrites(h, 1, older, ending)["s"].asString(), std::string("ok"));

  const Json::Value ended = pulled(h.user, "turn00000001");
  CHECK_EQ(dump(ended["f"]["state"]), dump(parse("[\"completed\",\"" + older + "\"]")));
  CHECK_EQ(dump(ended["f"]["text"]), dump(parse("[\"Add 2.5 kg.\",\"" + older + "\"]")));

  CHECK_FALSE(h.door.interrupt(h.user, "turn00000001"));
  CHECK_EQ(dump(pulled(h.user, "turn00000001")), dump(ended));
  CHECK(scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}

TEST(a_late_phone_running_write_lands_its_text_and_leaves_the_servers_interrupted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "running");
  CHECK(h.door.interrupt(h.user, "turn00000001"));
  const Json::Value interrupted = pulled(h.user, "turn00000001")["f"]["state"];
  const std::string newer = std::to_string(h.clock.now + 1'000) + ":0:r_phone000001";

  Json::Value still(Json::objectValue);
  still["state"] = "running";
  still["text"] = "Add 2.5 kg, and";
  CHECK_EQ(phoneWrites(h, 1, newer, still)["s"].asString(), std::string("ok"));

  const Json::Value message = pulled(h.user, "turn00000001");
  CHECK_EQ(dump(message["f"]["state"]), dump(interrupted));
  CHECK_EQ(dump(message["f"]["text"]), dump(parse("[\"Add 2.5 kg, and\",\"" + newer + "\"]")));
  CHECK(scopeConsistent(h.user));
  CHECK(h.failures.messages.empty());
}
