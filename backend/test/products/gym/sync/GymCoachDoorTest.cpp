#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/testing.h"

#include <cstdlib>
#include <string>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::doortest;

namespace {

// A phone's turn through /v1/sync: the conversation, the lifter's question and the Coach message in `state`.
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
  answer["at"] = Json::UInt64(1'760'000'000'006);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("thread", "thread000001", title, true),
                                      GymDoor::delta("message", "lifter000001", question, true),
                                      GymDoor::delta("message", "turn00000001", answer, true)}));
}

std::string storedState(const std::string& messageId) {
  PgLease lease{*pool()};
  pqxx::work txn{*lease};
  return txn.exec("select state from gym_messages where id=$1", pqxx::params{messageId})[0][0].as<std::string>();
}

}

TEST(the_server_interrupts_a_running_coach_message) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "running");

  h.door.interrupt(h.user, "turn00000001");

  CHECK_EQ(storedState("turn00000001"), std::string("interrupted"));
  CHECK(scopeConsistent(h.user));
}

TEST(a_coach_message_whose_writer_ended_its_turn_is_left_as_it_stands) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  Harness h;
  turn(h, "completed");

  h.door.interrupt(h.user, "turn00000001");
  h.door.interrupt(h.user, "turn00000009");

  CHECK_EQ(storedState("turn00000001"), std::string("completed"));
  CHECK(h.failures.messages.empty());
  CHECK(scopeConsistent(h.user));
}
