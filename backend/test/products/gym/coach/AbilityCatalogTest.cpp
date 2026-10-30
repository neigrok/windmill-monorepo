#include "products/gym/coach/AbilityCatalog.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "platform/domain/sync/Jcs.h"
#include "test/testing.h"

#include <map>
#include <set>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::coach;

namespace {

std::set<std::string> names(const std::vector<ToolDeclaration>& declarations) {
  std::set<std::string> out;
  for (const ToolDeclaration& declaration : declarations) out.insert(declaration.name());
  return out;
}

}  // namespace

TEST(gym_ability_catalog_offers_appendix_c_minus_withheld_and_seats_each_ability) {
  const AbilityCatalog& catalog = gymAbilityCatalog();
  CHECK_EQ(catalog.version(), 2);
  CHECK_EQ(catalog.abilities().size(), gymToolCatalog().size());

  const std::set<std::string> anon = names(catalog.offered(Seat::anon));
  CHECK_EQ(anon, (std::set<std::string>{"list_exercises", "list_sessions", "get_session", "get_sessions", "last_time",
                                        "get_last_times", "list_routines", "get_stats", "list_notes", "list_bodyweight",
                                        "create_routine", "create_exercise", "propose_routine_change",
                                        "propose_routine_removal", "propose_workout_change"}));
  std::set<std::string> bound = anon;
  bound.insert({"save_note", "share_session", "revoke_share"});
  CHECK_EQ(names(catalog.offered(Seat::bound)), bound);

  // A catalog/1 turn is offered and gated by catalog/1: everything but what catalog/2 added.
  const AbilityCatalog first = catalog.at(1);
  CHECK_EQ(first.version(), 1);
  CHECK_EQ(first.abilities().size(), catalog.abilities().size() - 1);
  CHECK_FALSE(first.find("propose_workout_change"));
  std::set<std::string> older = bound;
  older.erase("propose_workout_change");
  CHECK_EQ(names(first.offered(Seat::bound)), older);
  CHECK(catalog.find("propose_workout_change")->target == ProposalTarget::workout);
  CHECK(catalog.find("propose_routine_removal")->target == ProposalTarget::routine);

  // Every declared name the appendix withholds, or does not list, is offered on no seat.
  for (const char* withheld : {"start_session", "log_set", "log_sets", "import_session", "finish_session",
                               "discard_session", "update_exercise"}) {
    REQUIRE(catalog.find(withheld));
    CHECK(catalog.find(withheld)->agent == AgentRule::withheld);
  }
  CHECK(catalog.find("share_session")->host == AbilityHost::server);
  CHECK(catalog.find("revoke_share")->host == AbilityHost::server);
  CHECK(catalog.find("save_note")->seats == AbilitySeats::bound);
  CHECK(catalog.find("propose_routine_removal")->cls == AbilityClass::remove);
  CHECK(catalog.find("propose_routine_removal")->agent == AgentRule::proposes);
  CHECK_FALSE(catalog.find("get_record"));
}

// catalog.json is the catalog of record: every ability the C++ table holds carries its class, agent and seats.
TEST(gym_ability_catalog_class_agent_and_seats_are_catalog_json_s) {
  const Json::Value catalog = sync::parseJson(catalogText());
  std::map<std::string, Json::Value> pinned;
  for (const Json::Value& ability : catalog["abilities"]) pinned.emplace(ability["name"].asString(), ability);
  for (const Ability& ability : gymAbilityCatalog().abilities()) {
    const auto found = pinned.find(ability.name());
    if (found == pinned.end()) {
      ::testing::fail(("catalog.json holds no " + ability.name()).c_str(), __FILE__, __LINE__);
      continue;
    }
    Json::Value table(Json::objectValue);
    table["class"] = std::string(nameOf(ability.cls));
    table["agent"] = std::string(nameOf(ability.agent));
    table["seats"] = ability.seats == AbilitySeats::bound ? "bound" : "any";
    if (ability.since != 1) table["since"] = "catalog/" + std::to_string(ability.since);
    Json::Value json(Json::objectValue);
    for (const char* field : {"class", "agent", "seats", "since"})
      if (found->second.isMember(field)) json[field] = found->second[field];
    if (table != json)
      ::testing::fail((ability.name() + " drifts from catalog.json: the table says " + dump(table) + ", catalog.json " + dump(json)).c_str(),
                      __FILE__, __LINE__);
  }
}

TEST(gym_ability_catalog_marks_the_phone_creates_whose_ids_the_server_mints) {
  const AbilityCatalog& catalog = gymAbilityCatalog();
  for (const char* mints : {"create_routine", "create_exercise", "save_note", "propose_routine_change", "propose_routine_removal",
                            "propose_workout_change"})
    CHECK(catalog.find(mints)->mintsId());
  for (const char* keeps : {"share_session", "revoke_share", "list_routines", "last_time", "log_set"})
    CHECK_FALSE(catalog.find(keeps)->mintsId());
}

TEST(gym_ability_schema_check_names_the_first_break_at_every_depth) {
  const Json::Value schema = parse(R"({
    "type":"object","additionalProperties":false,"required":["id","name","entries"],
    "properties":{
      "id":{"type":"string","minLength":8,"maxLength":64,"pattern":"^[A-Za-z0-9_-]{8,64}$"},
      "name":{"type":"string","maxLength":10},
      "position":{"type":"integer","minimum":0,"maximum":3},
      "kind":{"type":"string","enum":["a","b"]},
      "load":{"type":"number","multipleOf":0.5},
      "tags":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":2,"uniqueItems":true},
      "entries":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["exerciseId"],
        "properties":{"exerciseId":{"type":"string"},"sets":{"type":"array","items":{"type":"object","additionalProperties":false,
          "properties":{"reps":{"type":"integer","minimum":1}}}}}}}
    }})");
  const auto check = [&](const char* input) { return schemaViolation(schema, parse(input)).value_or(""); };
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":5}]}]})"), std::string(""));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push"})"), std::string("the input is missing entries"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"extra":1})"), std::string("the input does not take extra"));
  CHECK_EQ(check(R"({"id":"short","name":"Push","entries":[]})"), std::string("id is shorter than 8"));
  CHECK_EQ(check(R"({"id":"rt_0000000!","name":"Push","entries":[]})"), std::string("id does not match ^[A-Za-z0-9_-]{8,64}$"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push day of the week","entries":[]})"), std::string("name is longer than 10"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"position":4})"), std::string("position is above 3"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"position":1.5})"), std::string("position must be \"integer\", not number"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"kind":"c"})"), std::string("kind must be one of [\"a\",\"b\"]"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"load":0.75})"), std::string("load is not a multiple of 0.5"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"tags":[]})"), std::string("tags holds fewer than 1 items"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[],"tags":["x","x"]})"), std::string("tags repeats an item"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[{"exerciseId":"a"},{"sets":[]}]})"), std::string("entries[1] is missing exerciseId"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[{"exerciseId":"a","sets":[{"reps":0}]}]})"), std::string("entries[0].sets[0].reps is below 1"));
  CHECK_EQ(check(R"({"id":"rt_00000001","name":"Push","entries":[{"exerciseId":"a","sets":[{"rpe":9}]}]})"), std::string("entries[0].sets[0] does not take rpe"));
  CHECK_EQ(check(R"([])"), std::string("the input must be \"object\", not array"));
}

TEST(gym_ability_schema_check_validates_the_real_catalog_inputs) {
  const AbilityCatalog& catalog = gymAbilityCatalog();
  const Json::Value& routine = catalog.find("create_routine")->declaration.descriptor["inputSchema"];
  CHECK_EQ(schemaViolation(routine, parse(R"({"id":"rt_00000001","name":"Push A","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":80}],"restSeconds":120}]})")).value_or(""), std::string(""));
  CHECK_EQ(schemaViolation(routine, parse(R"({"id":"rt_00000001","name":"Push A","position":0,"entries":[{"exerciseId":"bench-press","sets":[]}]})")).value_or(""), std::string("entries[0].sets holds fewer than 1 items"));
  const Json::Value& exercise = catalog.find("create_exercise")->declaration.descriptor["inputSchema"];
  CHECK_EQ(schemaViolation(exercise, parse(R"({"id":"ex_00000001","name":"Pause bench","pattern":"nope","equipment":"barbell"})")).value_or(""),
           std::string("pattern must be one of [\"squat\",\"hinge\",\"press\",\"pull\",\"carry\",\"core\",\"isolation\"]"));
}
