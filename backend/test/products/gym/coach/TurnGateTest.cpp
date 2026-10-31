#include "products/gym/coach/TurnGate.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <map>
#include <string>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::coach;

namespace {

Json::Value routine(const char* id, int position) {
  Json::Value input = parse(R"({"id":"","name":"Day","position":0,"entries":[{"exerciseId":"bench-press"}]})");
  input["id"] = id;
  input["position"] = position;
  return input;
}

}  // namespace

TEST(gym_turn_gate_mints_every_new_record_id_from_the_turn_in_call_order) {
  TurnGate gate(gymAbilityCatalog(), Seat::bound, "tn_gate_0000001");
  const GateVerdict first = gate.admit("create_routine", routine("rt_model_a", 0), false);
  const GateVerdict read = gate.admit("list_routines", Json::Value(Json::objectValue), false);
  const GateVerdict second = gate.admit("create_exercise", parse(R"({"id":"ex_model","name":"Pause bench","pattern":"press","equipment":"barbell"})"), false);
  const GateVerdict proposal = gate.admit("propose_routine_removal", parse(R"({"id":"prop_model","routineId":"rt_00000001"})"), false);
  REQUIRE(first.admitted);
  REQUIRE(read.admitted);
  REQUIRE(second.admitted);
  REQUIRE(proposal.admitted);
  CHECK_EQ(first.input["id"].asString(), std::string("tn_gate_0000001-1"));
  CHECK_EQ(first.input["name"].asString(), std::string("Day"));
  CHECK_FALSE(read.input.isMember("id"));
  CHECK_EQ(second.input["id"].asString(), std::string("tn_gate_0000001-2"));
  CHECK_EQ(proposal.input["id"].asString(), std::string("tn_gate_0000001-3"));
  CHECK_EQ(gate.admittedCalls(), 4);
}

TEST(gym_turn_gate_refuses_in_rule_order_and_counts_each_refusal_by_code) {
  TurnGate gate(gymAbilityCatalog(), Seat::anon, "tn_gate_0000002");
  CHECK_EQ(gate.admit("log_set", parse(R"({"sessionId":"ses_00000001","exerciseId":"bench-press","weightKg":80,"reps":5})"), false).code, std::string("not-offered"));
  CHECK_EQ(gate.admit("no_such_tool", Json::Value(Json::objectValue), false).code, std::string("not-offered"));
  CHECK_EQ(gate.admit("save_note", parse(R"({"id":"note_a","title":"T","body":"B"})"), false).code, std::string("seat-required"));
  CHECK_EQ(gate.admit("share_session", parse(R"({"sessionId":"ses_00000001"})"), false).code, std::string("seat-required"));
  const GateVerdict shape = gate.admit("create_routine", parse(R"({"id":"rt_a","name":"Day"})"), false);
  CHECK_EQ(shape.code, std::string("invalid-input"));
  CHECK_EQ(shape.message, std::string("create_routine: the input is missing position."));
  CHECK_EQ(gate.admit("list_routines", Json::Value(Json::objectValue), true).code, std::string("stopped"));
  CHECK_EQ(gate.refusals(), (std::map<std::string, int>{{"not-offered", 2}, {"seat-required", 2}, {"invalid-input", 1}, {"stopped", 1}}));
  CHECK_EQ(gate.admittedCalls(), 0);
}

TEST(gym_turn_gate_holds_one_proposal_and_one_note_until_a_failed_result_frees_the_slot) {
  TurnGate gate(gymAbilityCatalog(), Seat::bound, "tn_gate_0000003");
  const Json::Value change = parse(R"({"id":"prop_a","routineId":"rt_00000001","entries":[{"exerciseId":"bench-press"}]})");
  const GateVerdict first = gate.admit("propose_routine_change", change, false);
  REQUIRE(first.admitted);
  CHECK_EQ(gate.admit("propose_routine_removal", parse(R"({"id":"prop_b","routineId":"rt_00000002"})"), false).code, std::string("one-proposal"));
  gate.settle(*first.ability, false);
  const GateVerdict again = gate.admit("propose_routine_removal", parse(R"({"id":"prop_b","routineId":"rt_00000002"})"), false);
  CHECK(again.admitted);
  CHECK_EQ(again.input["id"].asString(), std::string("tn_gate_0000003-2"));

  const Json::Value note = parse(R"({"id":"note_a","title":"Knee","body":"Hurts."})");
  const GateVerdict saved = gate.admit("save_note", note, false);
  REQUIRE(saved.admitted);
  CHECK_EQ(gate.admit("save_note", note, false).code, std::string("one-note"));
  gate.settle(*saved.ability, true);
  CHECK_EQ(gate.admit("save_note", note, false).code, std::string("one-note"));
}

// G-4 holds one slot per target kind: a routine proposal and a workout proposal both land in one answer, and a
// catalog/1 turn has no workout proposal to offer.
TEST(gym_turn_gate_holds_one_proposal_per_target_kind) {
  const Json::Value workout = parse(R"({"id":"prop_w","sessionId":"ses_00000001","entries":[{"exerciseId":"bench-press"}]})");
  TurnGate gate(gymAbilityCatalog(), Seat::anon, "tn_gate_0000005");
  const GateVerdict routine = gate.admit("propose_routine_removal", parse(R"({"id":"prop_r","routineId":"rt_00000001"})"), false);
  const GateVerdict change = gate.admit("propose_workout_change", workout, false);
  REQUIRE(routine.admitted);
  REQUIRE(change.admitted);
  CHECK_EQ(change.input["id"].asString(), std::string("tn_gate_0000005-2"));
  CHECK_EQ(gate.admit("propose_routine_change", parse(R"({"id":"prop_a","routineId":"rt_00000001","entries":[{"exerciseId":"dip"}]})"), false).code,
           std::string("one-proposal"));
  const GateVerdict second = gate.admit("propose_workout_change", workout, false);
  CHECK_EQ(second.code, std::string("one-proposal"));
  CHECK_EQ(second.message, std::string("propose_workout_change: you already wrote a workout proposal this turn; fold both into one document."));
  gate.settle(*change.ability, false);
  CHECK(gate.admit("propose_workout_change", workout, false).admitted);

  const AbilityCatalog first = gymAbilityCatalog().at(1);
  TurnGate older(first, Seat::anon, "tn_gate_0000006");
  CHECK_EQ(older.admit("propose_workout_change", workout, false).code, std::string("not-offered"));
}

TEST(gym_turn_gate_bounds_adds_at_six_and_calls_at_twelve) {
  TurnGate adds(gymAbilityCatalog(), Seat::bound, "tn_gate_0000004");
  for (int number = 0; number < 6; ++number) CHECK(adds.admit("create_routine", routine("rt", number), false).admitted);
  CHECK_EQ(adds.admit("create_routine", routine("rt", 6), false).code, std::string("coach-turn-volume"));
  CHECK_EQ(adds.admit("create_exercise", parse(R"({"id":"ex_a","name":"Pause bench","pattern":"press","equipment":"barbell"})"), false).code,
           std::string("coach-turn-volume"));
  CHECK(adds.admit("list_routines", Json::Value(Json::objectValue), false).admitted);

  TurnGate calls(gymAbilityCatalog(), Seat::bound, "tn_gate_0000005");
  for (int number = 0; number < 12; ++number) CHECK(calls.admit("list_routines", Json::Value(Json::objectValue), false).admitted);
  CHECK_EQ(calls.admit("list_routines", Json::Value(Json::objectValue), false).code, std::string("coach-turn-volume"));
  CHECK_EQ(calls.admit("create_routine", routine("rt", 0), false).code, std::string("coach-turn-volume"));
}
