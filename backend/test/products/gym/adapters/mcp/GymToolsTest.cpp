#include "products/gym/adapters/mcp/GymTools.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "platform/domain/sync/FractionalIndex.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/application/AskService.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include <cctype>
#include <cstdlib>
#include <functional>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// The tools over an in-memory store holding two seeds and a door that writes nothing, for cases that write no row.
struct MemoryHarness {
  FakeGym repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  ReadOnlyDoor door;
  TrainingService training{repo.log, clock, tokens, door};
  GymTools tools{training, door, repo.catalog, repo.program, repo.notes, repo.bodyweight, "https://windmill.works"};

  MemoryHarness() {
    repo.db.seed(benchPress());
    repo.db.seed(backSquat());
  }
};

// One account's agent at the tools; CompositeToolHost settles the grant above them, so the scope is account-wide.
struct Agent {
  GymTools& tools;
  UserId user;

  ToolResult call(const char* name, const Json::Value& args) const {
    return tools.callTool(name, args, ToolCaller{user, ToolScope::everything()});
  }

  ToolResult start(const char* id, std::uint64_t startedAtMs) const {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["startedAt"] = Json::Value::UInt64(startedAtMs);
    return call("start_session", args);
  }

  ToolResult logSet(const char* session, const char* id, const char* exercise, double weightKg, int reps,
                    std::uint64_t completedAtMs) const {
    Json::Value args(Json::objectValue);
    args["sessionId"] = session;
    args["id"] = id;
    args["exerciseId"] = exercise;
    args["weightKg"] = weightKg;
    args["reps"] = reps;
    args["completedAt"] = Json::Value::UInt64(completedAtMs);
    return call("log_set", args);
  }

  ToolResult finish(const char* session, std::uint64_t finishedAtMs) const {
    Json::Value args(Json::objectValue);
    args["sessionId"] = session;
    args["finishedAt"] = Json::Value::UInt64(finishedAtMs);
    return call("finish_session", args);
  }

  ToolResult propose(const char* id, const char* routine, Json::Value entries) const {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["routineId"] = routine;
    args["entries"] = std::move(entries);
    return call("propose_routine_change", args);
  }
};

// The Push A day the lifter built by hand: one bench line, 5 × 5 at 82.5, three minutes' rest.
void createPushA(doortest::Harness& h) {
  CHECK_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId(), "Push A", 0, {benchEntry()}}, std::nullopt).error,
           RoutineWriteError::none);
}

// One column of the sync database, every row in the query's order: what the store holds, stated whole.
std::vector<std::string> stored(const std::string& query) {
  PgLease lease{*doortest::pool()};
  pqxx::read_transaction txn{*lease};
  std::vector<std::string> out;
  for (const auto& row : txn.exec(query)) out.push_back(row[0].as<std::string>());
  return out;
}

// One line of a document as an agent sends it: the scheme spelled out one set at a time.
Json::Value entryOf(const char* exercise, const std::vector<SetTarget>& scheme) {
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = exercise;
  entry["sets"] = toJson(scheme);
  return entry;
}

Json::Value oneEntry(const char* exercise, const std::vector<SetTarget>& scheme) {
  Json::Value entries(Json::arrayValue);
  entries.append(entryOf(exercise, scheme));
  return entries;
}

// The routine write as an agent sends it, one line long.
Json::Value routineArgs(const char* id, const char* name, Json::Value entries) {
  Json::Value args(Json::objectValue);
  args["id"] = id;
  args["name"] = name;
  args["position"] = 0;
  args["entries"] = std::move(entries);
  return args;
}

// The Lower A ramp on the wire, as list_routines and get_session hand it back: two decimals dropped
// to the shortest digits, keys alphabetical.
const char* kRampJson =
    R"([{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},{"reps":3,"weightKg":90.0},)"
    R"({"reps":1,"weightKg":100.0},{"reps":5,"weightKg":80.0}])";

Json::Value with(const char* field, const char* value) {
  Json::Value args(Json::objectValue);
  args[field] = value;
  return args;
}

const Json::Value& body(const ToolResult& result) { return result.payload; }

std::string message(const ToolResult& result) { return result.content[0]["text"].asString(); }

// The catalog as a table a human can read in one glance: "<tool> <level>", in declared order.
std::vector<std::string> classified(const std::vector<ToolDeclaration>& catalog) {
  std::vector<std::string> rows;
  for (const ToolDeclaration& tool : catalog)
    rows.push_back(tool.name() + " " + tool.product + ":" + wm::toString(tool.access));
  return rows;
}

// The domain's refusal as a fact a case can assert on: an entity is built, or it is not.
bool refuses(const std::function<void()>& build) {
  try {
    build();
    return false;
  } catch (const InvalidTraining&) {
    return true;
  }
}

std::vector<std::string> namesIn(const Json::Value& tools) {
  std::vector<std::string> names;
  for (const Json::Value& tool : tools) names.push_back(tool["name"].asString());
  return names;
}

// A product's published catalog with no service behind it, enough to prove what the composite does at construction.
struct CatalogOnly : ToolHost {
  std::vector<ToolDeclaration> catalog;
  explicit CatalogOnly(std::vector<ToolDeclaration> declared) : catalog(std::move(declared)) {}
  std::vector<ToolDeclaration> declareTools() const override { return catalog; }
  ToolResult callTool(const std::string&, const Json::Value&, const ToolCaller&) override {
    return ToolResult::failure("not dispatched in this test");
  }
};

}

// Pinned whole and in order, because this table is the permission model. Reads, then writes, then deletes.
TEST(gym_catalog_names_the_grant_level_that_reaches_every_tool) {
  CHECK_EQ(classified(gymToolCatalog()),
           (std::vector<std::string>{
               "list_exercises gym:read", "list_sessions gym:read", "get_session gym:read",
               "last_time gym:read", "list_routines gym:read", "get_stats gym:read",
               "list_notes gym:read", "list_bodyweight gym:read", "get_sessions gym:read", "get_last_times gym:read",
               "save_note gym:write", "start_session gym:write",
               "log_set gym:write", "finish_session gym:write",
               "create_routine gym:write", "propose_routine_change gym:write",
               "create_exercise gym:write", "share_session gym:write", "log_sets gym:write", "import_session gym:write",
               "discard_session gym:delete", "propose_routine_removal gym:delete",
               "revoke_share gym:delete"}));
}

// `create_routine` LANDS — a day that did not exist takes nothing away — and the two `propose_` tools land nothing.
TEST(gym_names_the_two_tools_that_only_propose_and_the_one_that_writes) {
  for (const ToolDeclaration& tool : gymToolCatalog()) {
    if (tool.name() != "propose_routine_change" && tool.name() != "propose_routine_removal")
      continue;
    const std::string described = tool.descriptor["description"].asString();
    // Each says what it does NOT do, in the first two sentences, in words a model acts on.
    CHECK(described.find("CHANGES NOTHING") != std::string::npos ||
          described.find("DELETES NOTHING") != std::string::npos);
    CHECK(described.find("tap Apply") != std::string::npos);
    CHECK(described.find("no apply tool") != std::string::npos ||
          described.find("nothing on this connection can tap it") != std::string::npos ||
          described.find("Nothing on this connection can") != std::string::npos);
  }
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "create_routine")
      CHECK(tool.descriptor["description"].asString().find("LANDS IMMEDIATELY") !=
            std::string::npos);
}

// Apply is not a capability: there is no tool for it at any level, and the dispatcher answers no such call.
TEST(gym_publishes_no_tool_that_applies_or_dismisses_a_proposal) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{uid(), ToolScope::everything()}));

  for (const std::string& name : everything) {
    CHECK(name != "apply_proposal");
    CHECK(name != "apply_routine_change");
    CHECK(name != "accept_proposal");
    CHECK(name != "dismiss_proposal");
    CHECK(name != "settle_proposal");
  }
  for (const char* name :
       {"apply_proposal", "apply_routine_change", "accept_proposal", "dismiss_proposal"})
    CHECK(me.call(name, Json::Value(Json::objectValue)).isError);
}

// Coach never creates: a proposal is anchored to a routine that already stands and a revision it is
// atomic against, and a create has neither. The `propose_` prefix is itself the grant that reaches
// Coach, so the name's absence is pinned here before anyone adds a tool by it.
TEST(gym_publishes_no_propose_routine_create_at_any_level) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  for (const ToolDeclaration& tool : gymToolCatalog()) CHECK(tool.name() != "propose_routine_create");
  for (const std::string& name :
       namesIn(h.tools.listTools(ToolCaller{uid(), ToolScope::everything()})))
    CHECK(name != "propose_routine_create");
  CHECK(me.call("propose_routine_create", Json::Value(Json::objectValue)).isError);
  CHECK_FALSE(h.tools.retirement("propose_routine_create").has_value());
}

// Notes are visible in precedence order; only the append tool may write an insight.
TEST(gym_list_notes_answers_in_precedence_order_and_claims_no_log_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  const Agent empty{h.tools, UserId{"77777777-7777-4777-8777-777777777779"}};
  REQUIRE(!me.call("save_note", parse(R"({"id":"note_00000001","title":"How I want to be talked to","body":"Blunt."})")).isError);
  REQUIRE(!me.call("save_note", parse(R"({"id":"note_00000002","title":"What I am training for","body":"A 140 squat."})")).isError);
  REQUIRE(!them.call("save_note", parse(R"({"id":"note_00000009","title":"Theirs","body":"Not yours."})")).isError);
  // The lifter drags the second note above the first on a phone, which writes its order key alone.
  Json::Value first(Json::objectValue);
  first["ord"] = sync::between(std::nullopt, stored("select ord from gym_notes where id = 'note_00000001'")[0]);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("note", "note_00000002", first)}));

  const ToolResult listed = me.call("list_notes", Json::Value(Json::objectValue));

  REQUIRE(!listed.isError);
  REQUIRE_EQ(body(listed)["notes"].size(), 2u);
  CHECK_EQ(body(listed)["notes"][0]["position"].asInt(), 0);
  CHECK_EQ(body(listed)["notes"][0]["title"].asString(), std::string("What I am training for"));
  CHECK_EQ(body(listed)["notes"][0]["body"].asString(), std::string("A 140 squat."));
  CHECK_EQ(body(listed)["notes"][1]["position"].asInt(), 1);
  CHECK_EQ(body(listed)["notes"][1]["title"].asString(), std::string("How I want to be talked to"));
  // The wire's id and instant are the app's, not the agent's; and a note is not a log row.
  CHECK_FALSE(body(listed)["notes"][0].isMember("id"));
  CHECK_FALSE(body(listed)["notes"][0].isMember("updatedAt"));
  CHECK_FALSE(body(listed).isMember("read"));
  CHECK_EQ(body(empty.call("list_notes", Json::Value(Json::objectValue)))["notes"].size(), 0u);

  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{h.user, ToolScope::everything()}));
  for (const std::string& name : everything) {

    CHECK(name != "create_note");
    CHECK(name != "write_note");
    CHECK(name != "delete_note");
    CHECK(name != "propose_note_change");
  }
  for (const char* name : {"save_note", "create_note", "write_note", "delete_note"})
    CHECK(me.call(name, Json::Value(Json::objectValue)).isError);
  CHECK_EQ(stored("select id from gym_notes order by id"),
           (std::vector<std::string>{"note_00000001", "note_00000002", "note_00000009"}));
  // The description carries the three bounds the entity and the schema keep.
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "list_notes") {
      const std::string described = tool.descriptor["description"].asString();
      CHECK(described.find("at most ten") != std::string::npos);
      CHECK(described.find("60 characters") != std::string::npos);
      CHECK(described.find("500 bytes") != std::string::npos);
      CHECK(described.find("top note wins") != std::string::npos);
    }
}

// The bodyweight read: day ascending, kilograms, the device instant kept off the agent's copy, no
// receipt, both bounds inclusive, and a bound that is not a calendar day refused before the store.
TEST(gym_list_bodyweight_answers_day_ascending_in_kilograms_and_claims_no_log_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent empty{h.tools, UserId{"77777777-7777-4777-8777-777777777779"}};
  h.clock.now = 1'787'659'200'000;   // 2026-08-25, so every weigh-in below is on or before tomorrow
  const auto weighIn = [&](const UserId& account, const char* day, double kg, std::uint64_t recordedAtMs) {
    Json::Value fields(Json::objectValue);
    fields["kg"] = kg;
    fields["recordedAt"] = Json::Value::UInt64(recordedAtMs);
    GymDoor::requireOk(h.admit(account, {GymDoor::delta("weighin", day, fields, true)}));
  };
  weighIn(h.user, "2026-08-03", 82.4, 1'785'000'000'000);
  weighIn(h.user, "2026-08-01", 83.0, 1'784'800'000'000);
  weighIn(h.user, "2026-08-25", 81.95, 1'786'000'000'000);
  weighIn(h.other, "2026-08-02", 70.0, 1'785'000'000'000);

  const ToolResult listed = me.call("list_bodyweight", Json::Value(Json::objectValue));

  REQUIRE(!listed.isError);
  REQUIRE_EQ(body(listed)["entries"].size(), 3u);
  CHECK_EQ(body(listed)["entries"][0]["dateLocal"].asString(), std::string("2026-08-01"));
  CHECK_EQ(body(listed)["entries"][0]["weightKg"].asDouble(), 83.0);
  CHECK_EQ(body(listed)["entries"][1]["dateLocal"].asString(), std::string("2026-08-03"));
  CHECK_EQ(body(listed)["entries"][2]["dateLocal"].asString(), std::string("2026-08-25"));
  CHECK_EQ(body(listed)["entries"][2]["weightKg"].asDouble(), 81.95);
  CHECK_FALSE(body(listed)["entries"][0].isMember("recordedAt"));
  CHECK_FALSE(body(listed).isMember("read"));
  // B3: the text the agent reads carries the two decimals the lifter wrote, never a double's noise.
  CHECK_EQ(message(listed),
           std::string(R"({"entries":[{"dateLocal":"2026-08-01","weightKg":83.0},)"
                       R"({"dateLocal":"2026-08-03","weightKg":82.4},)"
                       R"({"dateLocal":"2026-08-25","weightKg":81.95}]})"));

  Json::Value window(Json::objectValue);
  window["from"] = "2026-08-02";
  window["to"] = "2026-08-03";
  const ToolResult narrowed = me.call("list_bodyweight", window);
  REQUIRE(!narrowed.isError);
  REQUIRE_EQ(body(narrowed)["entries"].size(), 1u);
  CHECK_EQ(body(narrowed)["entries"][0]["dateLocal"].asString(), std::string("2026-08-03"));
  CHECK_EQ(body(empty.call("list_bodyweight", Json::Value(Json::objectValue)))["entries"].size(), 0u);

  Json::Value bad(Json::objectValue);
  bad["from"] = "2026-02-30";
  const ToolResult refused = me.call("list_bodyweight", bad);
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("list_bodyweight: \"from\" must be a calendar day written YYYY-MM-DD."));
  bad = Json::Value(Json::objectValue);
  bad["to"] = 20260803;
  CHECK_EQ(message(me.call("list_bodyweight", bad)),
           std::string("list_bodyweight: \"to\" must be a calendar day written YYYY-MM-DD."));
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "list_bodyweight") {
      const std::string described = tool.descriptor["description"].asString();
      CHECK(described.find("no tool that writes one") != std::string::npos);
      CHECK(described.find("never estimate") != std::string::npos);
    }
}

// A weigh-in is a fact only the lifter observed. No tool at any grant level writes one — not by
// any of the names a wave might reach for, not under `propose_`, which would hand it to Coach
// unread — so the ONLY tool whose name says bodyweight is the read, and every other name misses
// the dispatcher and leaves the store untouched. The ban is read off the declarations, not off a
// list of guesses: a tool is about bodyweight when its name or any argument it declares says so
// (`bodyweight`, `weigh_in`, or the weigh-in's own key `dateLocal` — `weightKg` is a set's load and
// is not it), and every such tool is a read. Coach's door offers nothing but reads and `propose_*`,
// so no future write could reach Coach under any name.
TEST(gym_publishes_no_tool_that_writes_a_bodyweight_at_any_level) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  h.clock.now = 1'787'659'200'000;   // 2026-08-25
  Json::Value weighIn(Json::objectValue);
  weighIn["kg"] = 82.4;
  weighIn["recordedAt"] = Json::Value::UInt64(1'786'000'000'000);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("weighin", "2026-08-25", weighIn, true)}));
  const std::vector<Bodyweight> before = h.repo.bodyweight.entries(h.user, BodyweightRange{});

  const auto saysBodyweight = [](std::string word) {
    for (char& c : word) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return word.find("bodyweight") != std::string::npos ||
           word.find("weigh_in") != std::string::npos ||
           word.find("weighin") != std::string::npos || word == "datelocal";
  };
  std::vector<std::string> aboutBodyweight;
  for (const ToolDeclaration& tool : gymToolCatalog()) {
    const std::string name = tool.name();
    bool about = saysBodyweight(name) || name.find("weigh") != std::string::npos ||
                 name.find("weight") != std::string::npos;
    for (const std::string& argument : tool.descriptor["inputSchema"]["properties"].getMemberNames())
      about = about || saysBodyweight(argument);
    if (!about) continue;
    aboutBodyweight.push_back(name);
    CHECK(tool.access == Access::read);
  }
  CHECK_EQ(aboutBodyweight, std::vector<std::string>{"list_bodyweight"});
  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{h.user, ToolScope::everything()}));
  for (const std::string& name : everything)
    CHECK(name == "list_bodyweight" || name.find("bodyweight") == std::string::npos);

  // Coach's door, read off its declarations: reads and `propose_*`, nothing else, and the read is
  // there while every write is not.
  AskTools coach(h.tools, ThreadId{"thr_00000001"});
  std::vector<std::string> offered;
  for (const ToolDeclaration& tool : coach.declareTools()) {
    CHECK(tool.access == Access::read || mintsProposal(tool.name()));
    offered.push_back(tool.name());
  }
  CHECK_EQ(offered, (std::vector<std::string>{"list_exercises", "list_sessions", "get_session",
                                              "last_time", "list_routines", "get_stats",
                                              "list_notes", "list_bodyweight", "get_sessions", "get_last_times",
                                              "propose_routine_change",
                                              "propose_routine_removal"}));

  Json::Value args(Json::objectValue);
  args["dateLocal"] = "2026-08-26";
  args["weightKg"] = 90.0;
  args["recordedAt"] = Json::Value::UInt64(1'786'100'000'000);
  for (const char* name :
       {"log_bodyweight", "save_bodyweight", "record_bodyweight", "set_bodyweight", "weigh_in",
        "log_weigh_in", "delete_bodyweight", "remove_bodyweight", "propose_bodyweight",
        "propose_bodyweight_change", "propose_weigh_in"}) {
    CHECK(me.call(name, args).isError);
    CHECK_FALSE(h.tools.retirement(name).has_value());
  }
  CHECK_EQ(h.repo.bodyweight.entries(h.user, BodyweightRange{}), before);
  CHECK_EQ(stored("select date_local from gym_bodyweight order by date_local"),
           std::vector<std::string>{"2026-08-25"});
}

// A retired name is answered by naming its replacement, never by "you were not granted gym:write".
TEST(gym_the_retired_routine_tools_name_what_replaced_them) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const std::vector<ToolRetirement> retired = h.tools.retiredTools();

  REQUIRE_EQ(retired.size(), std::size_t{3});
  CHECK_EQ(retired[0].name, std::string("save_routine"));
  CHECK_EQ(retired[0].replacement, std::string("propose_routine_change"));
  CHECK(retired[0].sentence.find("propose_routine_change") != std::string::npos);
  CHECK(retired[0].sentence.find("create_routine") != std::string::npos);
  CHECK_EQ(retired[1].name, std::string("delete_routine"));
  CHECK_EQ(retired[1].replacement, std::string("propose_routine_removal"));
  CHECK(retired[1].sentence.find("propose_routine_removal") != std::string::npos);
  CHECK_EQ(retired[2].name, std::string("get_preferences"));
  CHECK_EQ(retired[2].replacement, std::string(""));
  for (const ToolRetirement& retirement : retired) {
    CHECK(retirement.sentence.find("granted") == std::string::npos);
    CHECK_EQ(h.tools.retirement(retirement.name)->sentence, retirement.sentence);
    // Retired means gone: the dispatcher itself has no branch for the name any more.
    CHECK(me.call(retirement.name.c_str(), Json::Value(Json::objectValue)).isError);
  }
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  const ToolResult saved = surface.callTool("save_routine", Json::Value(Json::objectValue),
                                            ToolCaller{uid(), ToolScope::everything()});
  CHECK(saved.isError);
  CHECK_EQ(message(saved), "save_routine: " + retired[0].sentence);
}

// No agent may edit or delete a logged set at any level: the rule is about the verb, not the grant.
TEST(gym_publishes_no_tool_that_edits_or_deletes_a_logged_set) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{uid(), ToolScope::everything()}));

  for (const std::string& name : everything) {
    CHECK(name != "fix_set");
    CHECK(name != "edit_set");
    CHECK(name != "update_set");
    CHECK(name != "correct_set");
    CHECK(name != "delete_set");
    CHECK(name != "remove_set");
  }
  // The dispatcher answers no such call under any of those names either.
  for (const char* name : {"fix_set", "edit_set", "update_set", "delete_set"})
    CHECK(me.call(name, Json::Value(Json::objectValue)).isError);
}

// A set the lifter deleted on a phone leaves its id spent; re-sending it under `gym:write` is refused.
TEST(gym_log_set_cannot_bring_back_a_set_the_lifter_deleted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'700'000'000'000);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);
  h.kill(h.user, "set", "set_00000001");

  ToolResult replayed =
      me.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);

  CHECK(replayed.isError);
  CHECK_EQ(message(replayed),
           std::string("log_set: that set was deleted from the log. It is not coming back, and a "
                       "fresh id would only log it again — leave it out."));
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
}

TEST(gym_tools_list_carries_exactly_the_levels_a_grant_named) {
  MemoryHarness h;

  const std::vector<std::string> reads{"list_exercises", "list_sessions", "get_session",
                                       "last_time",      "list_routines", "get_stats",
                                       "list_notes",     "list_bodyweight", "get_sessions", "get_last_times"};
  const std::vector<std::string> writes{"save_note", "start_session",  "log_set",
                                        "finish_session", "create_routine",
                                        "propose_routine_change", "create_exercise",
                                        "share_session", "log_sets", "import_session"};
  const std::vector<std::string> deletes{"discard_session", "propose_routine_removal",
                                         "revoke_share"};

  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("gym:read")})), reads);

  std::vector<std::string> readWrite = reads;
  readWrite.insert(readWrite.end(), writes.begin(), writes.end());
  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("gym:read gym:write")})),
           readWrite);

  std::vector<std::string> everything = readWrite;
  everything.insert(everything.end(), deletes.begin(), deletes.end());
  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("gym:read gym:write gym:delete")})),
           everything);
}

// A grant naming only the OTHER product reaches nothing here — the gate is absence, not a shorter list.
TEST(gym_shows_nothing_to_a_grant_that_names_only_another_product) {
  MemoryHarness h;

  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("roadmap:read roadmap:write")})),
           (std::vector<std::string>{}));
}

// A duplicate tool name is a construction failure, so a collision takes the server down at start-up.
TEST(gym_and_roadmap_names_coexist_in_one_composite) {
  MemoryHarness h;
  CatalogOnly roadmap(roadmapToolCatalog());

  CompositeToolHost surface(std::vector<ToolModule>{{roadmap, "roadmap paragraph"},
                                                    {h.tools, gymInstructions()}});

  CHECK_EQ(surface.products(), (std::vector<std::string>{"roadmap", "gym"}));
  CHECK_EQ(namesIn(surface.listTools(ToolCaller{uid(), parseToolScope("gym:read")})),
           (std::vector<std::string>{"gym_list_exercises", "gym_list_sessions", "gym_get_session", "gym_last_time",
                                     "gym_list_routines", "gym_get_stats", "gym_list_notes",
                                     "gym_list_bodyweight", "gym_get_sessions", "gym_get_last_times"}));
  CHECK_EQ(static_cast<int>(surface.declareTools().size()),
           static_cast<int>(roadmapToolCatalog().size() + gymToolCatalog().size()));
}

// The schemas publish three vocabularies and the domain refuses against them; every word round-trips.
TEST(gym_catalog_publishes_the_vocabularies_the_domain_actually_parses) {
  for (const char* word : kPatterns) CHECK_EQ(toString(parsePattern(word)), std::string(word));
  for (const char* word : kEquipment) CHECK_EQ(toString(parseEquipment(word)), std::string(word));
  for (const char* word : kSetKinds) CHECK_EQ(toString(parseSetKind(word)), std::string(word));
  CHECK_EQ(kPatterns.size(), std::size_t{7});
  CHECK_EQ(kEquipment.size(), std::size_t{6});
  CHECK_EQ(kSetKinds.size(), std::size_t{4});
}

TEST(gym_tools_read_and_write_only_the_callers_own_log) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  me.start("ses_00000001", h.clock.now);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);

  const ToolResult stranger = them.call("get_session", with("sessionId", "ses_00000001"));
  CHECK(stranger.isError);
  CHECK_EQ(message(stranger),
           std::string("get_session: no workout of yours has that id. Call list_sessions for the "
                       "ids you own."));

  const ToolResult theirs = them.call("list_sessions", Json::Value(Json::objectValue));
  CHECK_FALSE(theirs.isError);
  CHECK_EQ(body(theirs)["sessions"].size(), 0u);

  const ToolResult mine = me.call("get_session", with("sessionId", "ses_00000001"));
  CHECK_FALSE(mine.isError);
  CHECK_EQ(body(mine)["sets"].size(), 1u);
}

// A stranger's write is refused by the same one fact its read is: never "another account's".
TEST(gym_a_write_into_someone_elses_workout_is_refused_as_absent) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  me.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      them.logSet("ses_00000001", "set_00000009", "bench-press", 80, 5, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: no workout of yours has that id. Call list_sessions for the ids "
                       "you own."));
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
}

TEST(gym_a_replayed_set_answers_with_the_row_already_stored) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);

  const ToolResult first =
      me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);
  const ToolResult replay =
      me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);

  CHECK_FALSE(replay.isError);
  CHECK_EQ(body(replay), body(first));
  CHECK_EQ(body(replay)["setNumber"].asInt(), 1);
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{"set_00000001"});
}

TEST(gym_a_replayed_start_answers_with_the_workout_already_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const ToolResult first = me.start("ses_00000001", h.clock.now);

  const ToolResult replay = me.start("ses_00000001", h.clock.now);

  CHECK_FALSE(replay.isError);
  CHECK_EQ(body(replay), body(first));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{"ses_00000001"});
}

TEST(gym_a_set_id_spent_in_another_workout_is_refused_by_name) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);
  me.finish("ses_00000001", h.clock.now + 120'000);
  me.start("ses_00000002", h.clock.now + 200'000);

  const ToolResult refused =
      me.logSet("ses_00000002", "set_00000001", "bench-press", 82.5, 5, h.clock.now + 260'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: that set id is already spent. Inspect get_session or list_sessions to reconcile "
                       "the log; preserve deleted sets. Retry only with the original id and body. "
                       "Use a fresh id only for a new performed set the user asks to record."));
}

TEST(gym_a_set_into_a_finished_workout_says_to_open_a_new_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);
  me.finish("ses_00000001", h.clock.now + 60'000);

  const ToolResult refused =
      me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 30'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: that workout is finished, so no new set can be added to it. Open a "
                       "new one with start_session."));
}

TEST(gym_a_set_naming_no_movement_points_at_the_catalog) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      me.logSet("ses_00000001", "set_00000001", "zercher-squat", 80, 5, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: no movement has that id. Call list_exercises for the catalog, or "
                       "create_exercise to add one."));
}

// A start in the future is refused before it is stored, naming the gap and the instant to send.
TEST(gym_a_start_in_the_logs_future_is_refused_and_names_the_gap) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};

  const ToolResult refused = me.start("ses_00000001", h.clock.now + 24ull * 60 * 60 * 1000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: that startedAt is 1440 minutes ahead of the log's clock, and "
                       "a workout cannot start in the future — the log would be locked behind it "
                       "until it aged out. Send the instant the workout actually began (now, for "
                       "one starting now), in epoch milliseconds."));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{});
}

TEST(gym_a_start_that_refuses_to_join_says_what_to_do_about_the_open_workout) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);

  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000002";
  args["startedAt"] = Json::Value::UInt64(h.clock.now + 1000);
  args["joinOpenSession"] = false;
  const ToolResult refused = me.call("start_session", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: a workout of yours is already open and this call said it "
                       "would not join one. Close it with finish_session first, or drop "
                       "joinOpenSession to log into it."));
}

TEST(gym_a_start_naming_no_routine_is_refused_rather_than_started_ad_hoc) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};

  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000001";
  args["startedAt"] = Json::Value::UInt64(h.clock.now);
  args["routineId"] = "rt_00000009";
  const ToolResult refused = me.call("start_session", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: no routine of yours has that id, so this workout was not "
                       "started rather than started with no plan. Call list_routines, or leave "
                       "routineId out for an ad-hoc workout."));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{});
}

TEST(gym_a_finish_before_the_start_is_refused_and_says_where_to_read_the_start) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);

  const ToolResult refused = me.finish("ses_00000001", h.clock.now - 1000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("finish_session: that workout cannot end at that instant — a workout ends at "
                       "or after it began. Read its `startedAt` with get_session."));
}

// The domain's own sentence, forwarded verbatim rather than flattened into "could not read that set".
TEST(gym_a_value_the_domain_refuses_reaches_the_agent_as_the_domains_own_sentence) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      me.logSet("ses_00000001", "set_00000001", "bench-press", 80, 0, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("log_set: reps out of range"));
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
}

TEST(gym_a_missing_handle_names_the_argument_and_the_tool_that_lists_it) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const ToolResult refused = me.call("get_session", Json::Value(Json::objectValue));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("get_session: missing required argument \"sessionId\". Call list_sessions "
                       "for the ids you own."));
}

TEST(gym_a_name_this_surface_does_not_serve_points_back_at_tools_list) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const ToolResult refused = me.call("bench_press_harder", Json::Value(Json::objectValue));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("bench_press_harder: no such gym tool — call tools/list for the surface this "
                       "connection may use."));
}

TEST(gym_arguments_that_are_not_an_object_are_named_by_type) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const ToolResult refused = me.call("list_sessions", Json::Value("ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("list_sessions: arguments must be a JSON object of this tool's named "
                       "arguments, got a string"));
}

TEST(gym_the_log_reads_newest_first_and_pages_on_both_halves_of_the_cursor) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.finish("ses_00000001", 1'060'000);
  me.start("ses_00000002", 2'000'000);
  me.finish("ses_00000002", 2'060'000);

  Json::Value page(Json::objectValue);
  page["limit"] = 1;
  const ToolResult first = me.call("list_sessions", page);
  REQUIRE_EQ(body(first)["sessions"].size(), 1u);
  CHECK_EQ(body(first)["sessions"][0]["id"].asString(), std::string("ses_00000002"));

  Json::Value next(Json::objectValue);
  next["before"] = Json::Value::UInt64(2'000'000);
  next["beforeId"] = "ses_00000002";
  const ToolResult second = me.call("list_sessions", next);
  REQUIRE_EQ(body(second)["sessions"].size(), 1u);
  CHECK_EQ(body(second)["sessions"][0]["id"].asString(), std::string("ses_00000001"));
}

TEST(gym_a_page_cursor_id_with_no_instant_beside_it_is_refused) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const ToolResult refused = me.call("list_sessions", with("beforeId", "ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("list_sessions: \"beforeId\" needs \"before\" beside it — an id with no "
                       "instant names no row in the page order."));
}

TEST(gym_the_session_read_carries_the_finish_readout_only_when_it_is_asked_for) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  me.finish("ses_00000001", 1'120'000);

  const ToolResult plain = me.call("get_session", with("sessionId", "ses_00000001"));
  CHECK_FALSE(body(plain).isMember("review"));

  Json::Value args(Json::objectValue);
  args["sessionId"] = "ses_00000001";
  args["review"] = true;
  const ToolResult withReview = me.call("get_session", args);
  REQUIRE(body(withReview).isMember("review"));
  CHECK_EQ(body(withReview)["review"]["stats"]["workingSets"].asInt(), 1);
  CHECK_EQ(body(withReview)["review"]["stats"]["durationMs"].asUInt64(), 120'000u);
}

TEST(gym_last_time_answers_a_first_ever_movement_with_the_movement_alone) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};

  const ToolResult never = me.call("last_time", with("exerciseId", "bench-press"));
  CHECK_FALSE(never.isError);
  CHECK_EQ(body(never)["exerciseId"].asString(), std::string("bench-press"));
  CHECK_FALSE(body(never).isMember("sets"));

  const ToolResult unknown = me.call("last_time", with("exerciseId", "zercher-squat"));
  CHECK(unknown.isError);
  CHECK_EQ(message(unknown),
           std::string("last_time: no movement has that id. Call list_exercises for the catalog, or "
                       "create_exercise to add one."));
}

TEST(gym_last_time_answers_with_the_sets_of_the_workout_that_held_them) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  me.logSet("ses_00000001", "set_00000002", "back-squat", 105, 3, 1'120'000);
  me.finish("ses_00000001", 1'180'000);

  const ToolResult last = me.call("last_time", with("exerciseId", "back-squat"));

  CHECK_FALSE(last.isError);
  CHECK_EQ(body(last)["session"]["id"].asString(), std::string("ses_00000001"));
  REQUIRE_EQ(body(last)["sets"].size(), 2u);
  CHECK_EQ(body(last)["sets"][1]["weightKg"].asDouble(), 105.0);
}

// The sixty-four seeds schema.sql writes, and one movement of the caller's own beside them.
TEST(gym_the_catalog_read_carries_the_seeds_and_the_callers_own_movements) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  Json::Value made(Json::objectValue);
  made["id"] = "ex_00000001";
  made["name"] = "Zercher Squat";
  made["pattern"] = "squat";
  made["equipment"] = "barbell";
  const ToolResult created = me.call("create_exercise", made);
  CHECK_FALSE(created.isError);
  CHECK_EQ(body(created)["stepKg"].asDouble(), 2.5);   // the equipment's own default
  CHECK(body(created)["custom"].asBool());

  const ToolResult mine = me.call("list_exercises", Json::Value(Json::objectValue));
  CHECK_EQ(mine.payload["exercises"].size(), 65u);
  const ToolResult theirs = them.call("list_exercises", Json::Value(Json::objectValue));
  CHECK_EQ(theirs.payload["exercises"].size(), 64u);
}

TEST(gym_a_movement_id_that_is_a_seeds_slug_is_refused_without_saying_whose) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  Json::Value made(Json::objectValue);
  made["id"] = "bench-press";
  made["name"] = "Bench Press";
  made["pattern"] = "press";
  made["equipment"] = "barbell";

  const ToolResult refused = me.call("create_exercise", made);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_exercise: that movement id is already spent. Mint a different one "
                       "and send it again — and read list_exercises first, in case the movement "
                       "itself is already there under another id."));
}

// The first close is permanent: a finish sent twice answers with the end the workout already has.
TEST(gym_a_second_finish_answers_with_the_end_the_workout_already_has) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  const ToolResult first = me.finish("ses_00000001", 1'060'000);

  const ToolResult again = me.finish("ses_00000001", 1'120'000);

  CHECK_FALSE(again.isError);
  CHECK_EQ(body(again), body(first));
  CHECK_EQ(body(again)["finishedAt"].asUInt64(), 1'060'000u);
}

TEST(gym_stats_narrow_to_one_movement_and_keep_the_weeks) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000'000);
  me.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'000'060'000);
  me.logSet("ses_00000001", "set_00000002", "bench-press", 80, 5, 1'000'120'000);
  me.finish("ses_00000001", 1'000'180'000);

  const ToolResult everything = me.call("get_stats", Json::Value(Json::objectValue));
  CHECK_EQ(body(everything)["movements"].size(), 2u);

  const ToolResult narrowed = me.call("get_stats", with("exerciseId", "back-squat"));
  REQUIRE_EQ(body(narrowed)["movements"].size(), 1u);
  CHECK_EQ(body(narrowed)["movements"][0]["exerciseId"].asString(), std::string("back-squat"));
  CHECK_EQ(body(narrowed)["weeks"].size(), body(everything)["weeks"].size());
}

// A schema is a promise about what the write will accept, so every bound in it is the DOMAIN's.
TEST(gym_the_routine_entry_schema_publishes_the_bounds_the_domain_actually_keeps) {
  Json::Value entries(Json::nullValue);
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "propose_routine_change")
      entries = tool.descriptor["inputSchema"]["properties"]["entries"];
  REQUIRE(entries.isObject());
  const Json::Value& fields = entries["items"]["properties"];

  // An entry takes exactly these four, and the scheme is a list, never a count.
  CHECK_EQ(fields.getMemberNames(),
           (std::vector<std::string>{"exerciseId", "position", "restSeconds", "sets"}));
  CHECK_EQ(fields["sets"]["type"].asString(), std::string("array"));
  CHECK_EQ(fields["sets"]["minItems"].asInt(), 1);
  CHECK_EQ(fields["sets"]["maxItems"].asInt(), static_cast<int>(kMaxSetTargets));
  const Json::Value& set = fields["sets"]["items"];
  CHECK_EQ(set["type"].asString(), std::string("object"));
  CHECK_EQ(set["properties"].getMemberNames(), (std::vector<std::string>{"reps", "weightKg"}));
  CHECK_EQ(set["properties"]["reps"]["type"].asString(), std::string("integer"));
  CHECK_EQ(set["properties"]["reps"]["minimum"].asInt(), 1);
  CHECK_EQ(set["properties"]["reps"]["maximum"].asInt(), 100);
  CHECK_EQ(set["properties"]["weightKg"]["type"].asString(), std::string("number"));
  CHECK_EQ(set["properties"]["weightKg"]["minimum"].asDouble(), -500.0);
  CHECK_EQ(set["properties"]["weightKg"]["maximum"].asDouble(), 500.0);
  CHECK_EQ(set["additionalProperties"].asBool(), false);
  CHECK(set["required"].isNull());   // each set's two absences mean something
  CHECK_EQ(fields["restSeconds"]["minimum"].asInt(), 15);
  CHECK_EQ(fields["restSeconds"]["maximum"].asInt(), 900);
  // The document's own size is published beside its fields' values.
  CHECK_EQ(entries["minItems"].asInt(), 1);
  CHECK_EQ(entries["maxItems"].asInt(), kMaxRoutineEntries);
  CHECK_EQ(entries["items"]["additionalProperties"].asBool(), false);

  // The promise, kept at both ends: each published extreme builds, and one past it does not.
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, straight(20, 100, 500.0), 900).sets,
           straight(20, 100, 500.0));
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, straight(1, 1, -500.0), 15).restSeconds,
           std::optional<int>(15));
  CHECK(refuses([] { SetTarget(101, 82.5); }));
  CHECK(refuses([] { SetTarget(0, 82.5); }));
  CHECK(refuses([] { SetTarget(5, 500.01); }));
  CHECK(refuses([] { SetTarget(5, -500.01); }));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, straight(21, 5, 82.5), 180); }));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, straight(5, 5, 82.5), 3600); }));
}

// The wire refuses the two shapes the schema forbids with the domain's own sentences: an empty list
// is a zero target, and twenty-one sets is one past the entity's ceiling.
TEST(gym_an_empty_scheme_and_one_past_twenty_sets_are_refused_with_the_domains_sentences) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  Json::Value zero(Json::objectValue);
  zero["exerciseId"] = "bench-press";
  zero["sets"] = Json::Value(Json::arrayValue);
  Json::Value entries(Json::arrayValue);
  entries.append(zero);

  const ToolResult noTarget = me.call("create_routine", routineArgs("rt_00000001", "Push A", entries));

  CHECK(noTarget.isError);
  CHECK_EQ(message(noTarget),
           std::string("create_routine: a zero target is no target — leave out the sets instead"));

  const ToolResult tooLong = me.call(
      "create_routine",
      routineArgs("rt_00000001", "Push A", oneEntry("bench-press", straight(21, 5, 82.5))));

  CHECK(tooLong.isError);
  CHECK_EQ(message(tooLong), std::string("create_routine: sets, 1 to 20"));
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{});
}

// A key an entry never declared is refused, never dropped.
TEST(gym_a_proposal_names_a_misspelled_entry_key_rather_than_dropping_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  Json::Value entry = entryOf("bench-press", straight(5, 5, 82.5));
  entry["targetRepsl"] = 5;
  Json::Value entries(Json::arrayValue);
  entries.append(entry);

  const ToolResult refused = me.propose("prop_00000001", "rt_00000001", entries);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("propose_routine_change: unknown routine entry field \"targetRepsl\". An "
                       "entry takes: exerciseId, sets, restSeconds."));
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});

  // And a key a SET never declared, one level down, is refused by the same rule.
  Json::Value misspelled = entryOf("bench-press", straight(5, 5, 82.5));
  misspelled["sets"][2]["weight"] = 85.0;
  Json::Value lines(Json::arrayValue);
  lines.append(misspelled);
  const ToolResult alsoRefused = me.propose("prop_00000001", "rt_00000001", lines);

  CHECK(alsoRefused.isError);
  CHECK_EQ(message(alsoRefused),
           std::string("propose_routine_change: unknown set field \"weight\". A set takes: reps, "
                       "weightKg."));
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});
}

// `position` is the store's own answer on a line list_routines hands over, so it is declared, accepted and ignored.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_propose_routine_change) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);

  // Read it back exactly as an agent would, and change the one thing it came for.
  const ToolResult listed = me.call("list_routines", Json::Value(Json::objectValue));
  REQUIRE(!listed.isError);
  Json::Value document = body(listed)["routines"][0];
  CHECK_EQ(document["entries"][0]["position"].asInt(), 1);
  document["entries"][0]["sets"][4]["weightKg"] = 85.0;

  const ToolResult minted = me.propose("prop_00000001", "rt_00000001", document["entries"]);

  REQUIRE(!minted.isError);
  const Json::Value& proposal = body(minted)["proposal"];
  REQUIRE_EQ(proposal["changes"].size(), 1u);
  CHECK_EQ(proposal["changes"][0]["kind"].asString(), std::string("retargeted"));
  // Both sides carry the whole scheme, so a card can draw the one set that moved.
  CHECK_EQ(dump(proposal["changes"][0]["before"]["sets"]),
           std::string(R"([{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5}])"));
  CHECK_EQ(dump(proposal["changes"][0]["after"]["sets"]),
           std::string(R"([{"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":82.5},{"reps":5,"weightKg":82.5},)"
                       R"({"reps":5,"weightKg":85.0}])"));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{Routine(rtId(), h.user, "Push A", 0, {benchEntry()})});
}

// Moving ONE set of a ramp is one retargeted line, and the diff hands over both whole schemes rather
// than the one item — the scheme is the unit a lifter reads and a card draws.
TEST(gym_moving_one_set_of_a_ramp_is_one_retargeted_line_carrying_both_whole_schemes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  REQUIRE_EQ(h.door.createRoutine(h.user, RoutineWrite{rtId(), "Lower A", 0,
                                                           {RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), 180}}},
                                     std::nullopt).error,
             RoutineWriteError::none);
  Json::Value document = body(me.call("list_routines", Json::Value(Json::objectValue)))["routines"][0];
  REQUIRE_EQ(dump(document["entries"][0]["sets"]), std::string(kRampJson));
  document["entries"][0]["sets"][3]["weightKg"] = 102.5;

  const ToolResult minted = me.propose("prop_00000001", "rt_00000001", document["entries"]);

  REQUIRE(!minted.isError);
  const Json::Value& changes = body(minted)["proposal"]["changes"];
  REQUIRE_EQ(changes.size(), 1u);
  CHECK_EQ(changes[0]["kind"].asString(), std::string("retargeted"));
  CHECK_EQ(changes[0]["position"].asInt(), 1);
  CHECK_EQ(changes[0]["exerciseId"].asString(), std::string("back-squat"));
  CHECK_EQ(dump(changes[0]["before"]["sets"]), std::string(kRampJson));
  CHECK_EQ(dump(changes[0]["after"]["sets"]),
           std::string(R"([{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},)"
                       R"({"reps":3,"weightKg":90.0},{"reps":1,"weightKg":102.5},)"
                       R"({"reps":5,"weightKg":80.0}])"));
  CHECK_EQ(changes[0]["before"]["restSeconds"].asInt(), 180);
  CHECK_EQ(changes[0]["after"]["restSeconds"].asInt(), 180);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{"prop_00000001"});
  std::vector<SetTarget> moved = ramp();
  moved[3] = SetTarget{1, 102.5};
  const std::optional<RoutineProposal> stored = h.repo.program.proposal(h.user, ProposalId{"prop_00000001"});
  REQUIRE(stored.has_value());
  CHECK_EQ(stored->changes[0].before, std::optional<EntryTargets>(EntryTargets{ramp(), 180}));
  CHECK_EQ(stored->changes[0].after, std::optional<EntryTargets>(EntryTargets{moved, 180}));
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->entries[0].sets, ramp());
}

// Nothing an agent can call changes an existing routine: the stored rows are compared whole, before and after.
TEST(gym_proposing_a_change_writes_nothing_to_the_program) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  const std::vector<Routine> before = h.repo.program.routines(h.user);

  const ToolResult minted =
      me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.program.routines(h.user), before);
  // The receipt is not shaped like a write: no routine in it, and the state says so.
  CHECK(body(minted)["routine"].isNull());
  CHECK_EQ(body(minted)["proposal"]["state"].asString(), std::string("pending"));
  CHECK_EQ(body(minted)["proposal"]["changeCount"].asInt(), 1);
  CHECK_EQ(body(minted)["reviewUrl"].asString(),
           std::string("https://windmill.works/#/gym/proposals/prop_00000001"));
  CHECK(body(minted)["note"].asString().find("Nothing has changed") != std::string::npos);
  CHECK(body(minted)["note"].asString().find("no tool on this connection can apply it") !=
        std::string::npos);
}

// One pending proposal per routine per door: a second supersedes the first, which drops into the history.
TEST(gym_a_second_proposal_supersedes_the_first_and_the_first_stays_in_the_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));
  h.clock.now += 60'000;

  const ToolResult second =
      me.propose("prop_00000002", "rt_00000001", oneEntry("bench-press", straight(5, 3, 90.0)));

  REQUIRE(!second.isError);
  const std::vector<ProposalHead> heads =
      h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{2});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[1].state, ProposalState::superseded);
  CHECK_EQ(heads[1].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  // And only one of them is what a card draws.
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}).size(), std::size_t{1});
}

// The transport resolves a connection — id and registered name — and the tool stores both on the proposal.
TEST(gym_a_proposal_minted_over_a_connection_carries_that_connections_id_and_name) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  createPushA(h);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", straight(5, 3, 87.5));
  const ToolCaller claude{h.user, ToolScope::everything(), ToolConnection{"cli_x", "Claude Desktop"}};

  const ToolResult minted = h.tools.callTool("propose_routine_change", args, claude);

  REQUIRE(!minted.isError);
  REQUIRE_EQ(stored("select id from gym_proposals"), std::vector<std::string>{"prop_00000001"});
  CHECK((h.repo.program.proposal(h.user, ProposalId{"prop_00000001"})->head.source ==
         ProposalSource{ProposalDoor::mcp, "cli_x", "Claude Desktop", std::nullopt}));
  const Json::Value& source = body(minted)["proposal"]["source"];
  CHECK_EQ(source["door"].asString(), std::string("mcp"));
  CHECK_EQ(source["connection"].asString(), std::string("cli_x"));
  CHECK_EQ(source["agent"].asString(), std::string("Claude Desktop"));
  const Json::Value listed = body(h.tools.callTool("list_routines", Json::Value(Json::objectValue), claude));
  CHECK_EQ(listed["routines"][0]["pendingProposal"]["source"]["connection"].asString(),
           std::string("cli_x"));
  CHECK_EQ(listed["routines"][0]["pendingProposal"]["source"]["agent"].asString(),
           std::string("Claude Desktop"));
}

// One pending proposal per (routine, door, connection): two agents each hold their own, and the same agent proposing twice replaces its own.
TEST(gym_two_connections_each_hold_a_pending_proposal_on_one_routine_and_one_connection_holds_one) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  createPushA(h);
  const ToolCaller claude{h.user, ToolScope::everything(), ToolConnection{"cli_x", "Claude Desktop"}};
  const ToolCaller cursor{h.user, ToolScope::everything(), ToolConnection{"key_y", "Cursor"}};
  auto proposeAs = [&](const char* id, double kg, const ToolCaller& who) {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["routineId"] = "rt_00000001";
    args["entries"] = oneEntry("bench-press", straight(5, 3, kg));
    return h.tools.callTool("propose_routine_change", args, who);
  };

  REQUIRE(!proposeAs("prop_00000001", 87.5, claude).isError);
  h.clock.now += 60'000;
  REQUIRE(!proposeAs("prop_00000002", 90.0, cursor).isError);
  h.clock.now += 60'000;
  REQUIRE(!proposeAs("prop_00000003", 92.5, claude).isError);

  const std::vector<ProposalHead> heads =
      h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{3});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000003"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[1].state, ProposalState::pending);
  CHECK_EQ(heads[2].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[2].state, ProposalState::superseded);
  CHECK_EQ(heads[2].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}).size(), std::size_t{2});
}

// A replay reads back the proposal it already minted: the id is the idempotency key here as everywhere.
TEST(gym_a_replayed_proposal_reads_back_the_one_already_waiting) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  const ToolResult replayed =
      me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  REQUIRE(!replayed.isError);
  CHECK_EQ(body(replayed)["proposal"]["state"].asString(), std::string("pending"));
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{"prop_00000001"});
}

// A replay is decided on the DOCUMENT and never on the id alone: a different diff under a spent id is refused.
TEST(gym_a_proposal_id_resent_with_a_different_document_is_refused_rather_than_answered_ok) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  const ToolResult second =
      me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(3, 12, 50.0)));

  CHECK(second.isError);
  CHECK(message(second).find("DIFFERENT proposal") != std::string::npos);
  CHECK(message(second).find("NOTHING WAS MINTED") != std::string::npos);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{"prop_00000001"});
  const std::optional<RoutineProposal> standing = h.repo.program.proposal(h.user, ProposalId{"prop_00000001"});
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->head.state, ProposalState::pending);
  CHECK_EQ(standing->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{straight(5, 3, 87.5), std::nullopt}));
}

// Every field list_routines puts on a routine survives a read-and-send-back.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_create_routine) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  createPushA(h);
  me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  Json::Value document = body(me.call("list_routines", Json::Value(Json::objectValue)))["routines"][0];
  REQUIRE_EQ(document["revision"].asInt(), 1);
  REQUIRE(document.isMember("pendingProposal"));
  document["id"] = "rt_00000002";
  document["name"] = "Push B";

  const ToolResult duplicated =
      surface.callTool("create_routine", document, ToolCaller{h.user, ToolScope::everything()});

  REQUIRE(!duplicated.isError);
  CHECK_EQ(body(duplicated)["name"].asString(), std::string("Push B"));
  CHECK_EQ(body(duplicated)["revision"].asInt(), 1);
  CHECK(body(duplicated)["pendingProposal"].isNull());
  CHECK_EQ(stored("select id from gym_routines order by id"),
           (std::vector<std::string>{"rt_00000001", "rt_00000002"}));
}

// The dot on the read an agent already makes, which is why there is no `list_proposals` here.
TEST(gym_list_routines_carries_the_proposal_waiting_on_a_day_of_the_program) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);

  const Json::Value quiet = body(me.call("list_routines", Json::Value(Json::objectValue)));
  me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));
  const Json::Value waiting = body(me.call("list_routines", Json::Value(Json::objectValue)));

  CHECK(quiet["routines"][0]["pendingProposal"].isNull());
  CHECK_EQ(quiet["routines"][0]["revision"].asInt(), 1);
  const Json::Value& pending = waiting["routines"][0]["pendingProposal"];
  CHECK_EQ(pending["id"].asString(), std::string("prop_00000001"));
  CHECK_EQ(pending["state"].asString(), std::string("pending"));
  CHECK_EQ(pending["changeCount"].asInt(), 1);
  CHECK_EQ(pending["source"]["door"].asString(), std::string("mcp"));
  // Empty while the transport carries neither, so a card draws a truthful fallback.
  CHECK(pending["source"]["connection"].isNull());
  CHECK(pending["source"]["agent"].isNull());
  CHECK(pending["changes"].isNull());
}

// A day of the program that does not exist yet is `fresh` and lands; one that already stands is not this tool's.
TEST(gym_create_routine_lands_and_sends_an_existing_day_to_the_proposal_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  Json::Value args = routineArgs("rt_00000001", "Push A", oneEntry("bench-press", straight(5, 5, 82.5)));

  const ToolResult created = me.call("create_routine", args);
  REQUIRE(!created.isError);
  CHECK_EQ(body(created)["name"].asString(), std::string("Push A"));
  CHECK_EQ(body(created)["revision"].asInt(), 1);
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{"rt_00000001"});

  // A lost reply is resent verbatim, and this product answers a replay everywhere else.
  const ToolResult replayed = me.call("create_routine", args);
  CHECK_FALSE(replayed.isError);
  CHECK_EQ(body(replayed)["revision"].asInt(), 1);
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{"rt_00000001"});

  args["name"] = "Push A — heavy";
  const ToolResult again = me.call("create_routine", args);

  CHECK(again.isError);
  CHECK(message(again).find("propose_routine_change") != std::string::npos);
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->name, std::string("Push A"));   // the edit did not land
}

// A line with no `sets` is OPEN and the rack decides; the created day names the door it came through.
TEST(gym_create_routine_takes_an_open_line_and_the_history_names_the_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  Json::Value open(Json::objectValue);
  open["exerciseId"] = "barbell-row";
  Json::Value entries(Json::arrayValue);
  entries.append(open);

  const ToolResult created =
      me.call("create_routine", routineArgs("rt_00000001", "Heavy Thursday", entries));

  REQUIRE(!created.isError);
  CHECK_FALSE(body(created)["entries"][0].isMember("sets"));   // omitted: the line asks at the rack
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->entries[0].sets, std::vector<SetTarget>{});
  const std::vector<RoutineEvent> history =
      h.repo.program.routineHistory(h.user, RoutineId{"rt_00000001"});
  REQUIRE_EQ(history.size(), std::size_t{1});
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
  CHECK_EQ(history[0].movements, std::optional<int>(1));

  // The published schema does not demand the field, so an agent need not invent a number.
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "create_routine") {
      const Json::Value& required =
          tool.descriptor["inputSchema"]["properties"]["entries"]["items"]["required"];
      REQUIRE_EQ(required.size(), 1u);
      CHECK_EQ(required[0].asString(), std::string("exerciseId"));
    }
}

// A ramp lands set by set and reads back in lifting order, byte for byte.
TEST(gym_create_routine_lands_a_ramp_and_list_routines_reads_the_five_sets_back_in_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};

  const ToolResult created =
      me.call("create_routine", routineArgs("rt_00000001", "Lower A", oneEntry("back-squat", ramp())));

  REQUIRE(!created.isError);
  CHECK_EQ(dump(body(created)["entries"][0]["sets"]), std::string(kRampJson));
  const ToolResult listed = me.call("list_routines", Json::Value(Json::objectValue));
  REQUIRE(!listed.isError);
  REQUIRE_EQ(body(listed)["routines"].size(), 1u);
  CHECK_EQ(dump(body(listed)["routines"][0]["entries"]),
           std::string(R"([{"exerciseId":"back-squat","position":1,"sets":)") + kRampJson + "}]");
  CHECK_EQ(h.repo.program.routines(h.user),
           std::vector<Routine>{Routine(rtId(), h.user, "Lower A", 0,
                                        {RoutineEntry{1, ExerciseId{"back-squat"}, ramp(), std::nullopt}})});
}

// A replay is decided on the SCHEME, set by set: the same ramp answers the stored day, and the same
// id with one set moved is an edit that this tool refuses toward the proposal door.
TEST(gym_a_replayed_create_routine_matches_the_scheme_set_by_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const ToolResult first =
      me.call("create_routine", routineArgs("rt_00000001", "Lower A", oneEntry("back-squat", ramp())));
  REQUIRE(!first.isError);

  const ToolResult replayed =
      me.call("create_routine", routineArgs("rt_00000001", "Lower A", oneEntry("back-squat", ramp())));

  REQUIRE(!replayed.isError);
  CHECK_EQ(body(replayed), body(first));
  CHECK_EQ(stored("select id from gym_routines"), std::vector<std::string>{"rt_00000001"});

  std::vector<SetTarget> moved = ramp();
  moved[3] = SetTarget{1, 102.5};
  const ToolResult edited =
      me.call("create_routine", routineArgs("rt_00000001", "Lower A", oneEntry("back-squat", moved)));

  CHECK(edited.isError);
  CHECK_EQ(message(edited),
           std::string("create_routine: that routine already stands and this document is not the "
                       "one it holds, so this is a change rather than the replay of a lost reply. A "
                       "day of the program that already stands is not this tool's to rewrite: send "
                       "it to propose_routine_change, which hands the lifter a typed diff and "
                       "changes nothing until they tap Apply."));
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->entries[0].sets, ramp());
  CHECK_EQ(h.repo.program.routine(h.user, rtId())->revision, 1);
}

// The plan a workout starts under is a COPY of the routine's scheme, and the session read hands it
// back set by set.
TEST(gym_a_workout_started_from_a_ramp_carries_the_five_sets_on_its_plan) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  REQUIRE(!me.call("create_routine",
                   routineArgs("rt_00000001", "Lower A", oneEntry("back-squat", ramp())))
               .isError);
  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000001";
  args["startedAt"] = Json::Value::UInt64(h.clock.now);
  args["routineId"] = "rt_00000001";
  REQUIRE(!me.call("start_session", args).isError);

  const ToolResult read = me.call("get_session", with("sessionId", "ses_00000001"));

  REQUIRE(!read.isError);
  CHECK_EQ(body(read)["session"]["routineId"].asString(), std::string("rt_00000001"));
  CHECK_EQ(dump(body(read)["session"]["plan"]),
           std::string(R"({"entries":[{"exerciseId":"back-squat","sets":)") + kRampJson +
               R"(}],"routine":"Lower A"})");
  const std::optional<Session> stored = h.repo.log.session(h.user, sid());
  REQUIRE(stored.has_value());
  REQUIRE(stored->plan.has_value());
  CHECK_EQ(stored->plan->entries,
           (std::vector<PlanEntry>{PlanEntry{ExerciseId{"back-squat"}, ramp(), std::nullopt}}));
}

// Refused at the mint, not at the tap.
TEST(gym_a_proposal_naming_no_movement_is_refused_before_it_is_ever_minted) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);

  const ToolResult refused =
      me.propose("prop_00000001", "rt_00000001", oneEntry("zercher-squat", straight(5, 5, 82.5)));

  CHECK(refused.isError);
  CHECK(message(refused).find("was not minted") != std::string::npos);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});
}

TEST(gym_proposing_a_change_to_a_routine_that_is_not_yours_points_at_the_two_doors) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};

  const ToolResult refused =
      me.propose("prop_00000001", "rt_00000009", oneEntry("bench-press", straight(5, 5, 82.5)));

  CHECK(refused.isError);
  CHECK(message(refused).find("list_routines") != std::string::npos);
  CHECK(message(refused).find("create_routine") != std::string::npos);
}

TEST(gym_a_routine_read_narrows_to_one_and_wears_the_same_wrapper) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);

  const ToolResult all = me.call("list_routines", Json::Value(Json::objectValue));
  CHECK_EQ(body(all)["routines"].size(), 1u);

  const ToolResult one = me.call("list_routines", with("routineId", "rt_00000001"));
  REQUIRE_EQ(body(one)["routines"].size(), 1u);
  CHECK_EQ(body(one)["routines"][0]["id"].asString(), std::string("rt_00000001"));

  const ToolResult missing = me.call("list_routines", with("routineId", "rt_00000009"));
  CHECK(missing.isError);
  CHECK_EQ(message(missing),
           std::string("list_routines: no routine of yours has that id. Call this tool with no "
                       "routineId to list the ones you own."));
}

TEST(gym_the_share_tool_answers_with_a_url_anyone_holding_it_can_open) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.finish("ses_00000001", 1'060'000);

  const ToolResult minted = me.call("share_session", with("sessionId", "ses_00000001"));

  CHECK_FALSE(minted.isError);
  const std::string token = body(minted)["token"].asString();
  // Deliberately NOT the api origin: a share becomes a page in the browser app.
  CHECK_EQ(body(minted)["url"].asString(), "https://windmill.works/#/gym/shared/" + token);
  CHECK_EQ(body(minted)["expiresAt"].asUInt64(), shareExpiryAt(h.clock.now));
  // The link resolves, without a caller, to that one workout.
  REQUIRE(h.training.shared(token).has_value());
  CHECK_EQ(h.training.shared(token)->startedAtMs, 1'000'000u);
}

TEST(gym_minting_a_share_twice_hands_back_the_same_live_link) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.finish("ses_00000001", 1'060'000);

  const ToolResult first = me.call("share_session", with("sessionId", "ses_00000001"));
  const ToolResult again = me.call("share_session", with("sessionId", "ses_00000001"));

  CHECK_EQ(body(again)["token"].asString(), body(first)["token"].asString());
  CHECK_EQ(stored("select session_id from gym_session_shares"), std::vector<std::string>{"ses_00000001"});
}

TEST(gym_revoking_a_share_ends_the_link_and_a_second_revoke_says_there_is_nothing_to_end) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.finish("ses_00000001", 1'060'000);
  const std::string token =
      body(me.call("share_session", with("sessionId", "ses_00000001")))["token"].asString();

  const ToolResult revoked = me.call("revoke_share", with("sessionId", "ses_00000001"));
  CHECK_FALSE(revoked.isError);
  CHECK(body(revoked)["revoked"].asBool());
  CHECK_FALSE(h.training.shared(token).has_value());

  const ToolResult again = me.call("revoke_share", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("revoke_share: there is no live share link on that workout, so there is "
                       "nothing to revoke — revoked, expired and never-minted are one answer here."));
}

TEST(gym_a_running_workout_is_not_discarded_and_the_refusal_says_why) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);

  const ToolResult refused = me.call("discard_session", with("sessionId", "ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("discard_session: that workout is still running, and deleting one somebody "
                       "is logging into destroys the sets in flight. Close it with finish_session "
                       "first, then discard it."));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{"ses_00000001"});
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{"set_00000001"});
}

TEST(gym_discarding_a_finished_workout_takes_its_sets_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'000'000);
  me.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  me.finish("ses_00000001", 1'120'000);

  const ToolResult discarded = me.call("discard_session", with("sessionId", "ses_00000001"));

  CHECK_FALSE(discarded.isError);
  CHECK(body(discarded)["deleted"].asBool());
  CHECK_EQ(body(discarded)["sessionId"].asString(), std::string("ses_00000001"));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{});
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});

  const ToolResult again = me.call("discard_session", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("discard_session: no workout of yours has that id. Call list_sessions for "
                       "the ids you own."));
}

// `gym:delete` buys the right to PROPOSE a destructive change and nothing else.
TEST(gym_proposing_a_removal_deletes_nothing_and_draws_what_would_go) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  const std::vector<Routine> before = h.repo.program.routines(h.user);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["summary"] = "You have not trained this in three months.";

  const ToolResult minted = me.call("propose_routine_removal", args);

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.program.routines(h.user), before);
  const Json::Value& proposal = body(minted)["proposal"];
  CHECK_EQ(proposal["intent"].asString(), std::string("remove"));
  CHECK_EQ(proposal["state"].asString(), std::string("pending"));
  REQUIRE_EQ(proposal["changes"].size(), 1u);
  CHECK_EQ(proposal["changes"][0]["kind"].asString(), std::string("removed"));
  CHECK_EQ(proposal["changes"][0]["exerciseId"].asString(), std::string("bench-press"));
  // The kept-set count, counted at read time so it is true when a lifter reads it.
  CHECK_EQ(proposal["changes"][0]["loggedSets"].asInt(), 0);
  CHECK(proposal["changes"][0]["after"].isNull());
}

// The removal's diff names how many sets each line keeps: the day leaves the program and the log does not move.
TEST(gym_a_removal_proposal_counts_the_sets_each_line_keeps) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  me.start("ses_00000001", 1'700'000'000'000);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'060'000);
  me.logSet("ses_00000001", "set_00000002", "bench-press", 82.5, 5, 1'700'000'120'000);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";

  const ToolResult minted = me.call("propose_routine_removal", args);

  REQUIRE(!minted.isError);
  CHECK_EQ(body(minted)["proposal"]["changes"][0]["loggedSets"].asInt(), 2);
}

// No agent may read or write a lifter's settings at any level: the rule is about the verb, not the grant.
TEST(gym_publishes_no_tool_that_reads_or_writes_a_lifters_settings) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};

  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{h.user, ToolScope::everything()}));

  for (const std::string& name : everything) {
    CHECK(name != "get_preferences");
    CHECK(name != "set_preferences");
    CHECK(name != "save_preferences");
    CHECK(name != "update_preferences");
    CHECK(name != "set_units");
    CHECK(name != "set_plates");
  }
  for (const char* name : {"get_preferences", "set_preferences", "save_preferences",
                           "update_preferences", "set_units"})
    CHECK(me.call(name, Json::Value(Json::objectValue)).isError);
  CHECK_EQ(stored("select user_id::text from gym_preferences"), std::vector<std::string>{});
}

// The one retirement in this catalog with no replacement to name, so the sentence says that out loud.
TEST(gym_retired_get_preferences_says_that_nothing_replaced_it) {
  MemoryHarness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});

  const ToolResult refused = surface.callTool("get_preferences", Json::Value(Json::objectValue),
                                              ToolCaller{uid(), parseToolScope("gym:read")});

  CHECK(refused.isError);
  CHECK(message(refused).find("retired") != std::string::npos);
  CHECK(message(refused).find("nothing replaced it") != std::string::npos);
  // The level was granted; the tool is gone.
  CHECK(message(refused).find("granted") == std::string::npos);
  CHECK_EQ(h.tools.retirement("get_preferences")->replacement, std::string(""));
}

// The rest dial is inherited at the rack and this server fills in nothing, with the lifter's dial armed.
TEST(gym_an_armed_rest_dial_is_never_copied_into_a_routine_line_that_names_none) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  Json::Value dials(Json::objectValue);
  dials["units"] = "kg";
  dials["restSeconds"] = 120;
  dials["restSound"] = true;
  dials["confirmHaptic"] = true;
  dials["confirmSound"] = false;
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("prefs", "prefs", dials)}));

  CHECK(!me.call("create_routine", routineArgs("rt_00000001", "Push A",
                                                oneEntry("bench-press", straight(5, 5, std::nullopt))))
             .isError);

  const ToolResult listed = me.call("list_routines", Json::Value(Json::objectValue));

  CHECK_FALSE(listed.isError);
  CHECK(body(listed)["routines"][0]["entries"][0]["restSeconds"].isNull());
  // A set naming reps alone carries exactly that: the load is last time's, filled in by nobody here.
  CHECK_EQ(dump(body(listed)["routines"][0]["entries"][0]["sets"]),
           std::string(R"([{"reps":5},{"reps":5},{"reps":5},{"reps":5},{"reps":5}])"));
  CHECK_EQ(h.repo.preferences.preferences(h.user), std::optional(GymPreferences(h.user, Unit::kg, 120, true, true, false)));
}

// `gym:read` cannot mint a proposal, and the gate is the composite's rather than gym's, so it is called through it.
TEST(gym_read_alone_cannot_mint_a_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  createPushA(h);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", straight(5, 3, 87.5));

  const ToolResult refused =
      surface.callTool("propose_routine_change", args, ToolCaller{h.user, parseToolScope("gym:read")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:write") != std::string::npos);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});
  // And a grant that names the level mints, through the very same door.
  CHECK_FALSE(surface
                  .callTool("propose_routine_change", args,
                            ToolCaller{h.user, parseToolScope("gym:read gym:write")})
                  .isError);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{"prop_00000001"});
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{Routine(rtId(), h.user, "Push A", 0, {benchEntry()})});
}

// A removal is `gym:delete`'s: the three levels are a grant vocabulary and none implies another.
TEST(gym_write_alone_cannot_propose_a_removal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  createPushA(h);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";

  const ToolResult refused = surface.callTool("propose_routine_removal", args,
                                              ToolCaller{h.user, parseToolScope("gym:write")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:delete") != std::string::npos);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});
}

// A document identical to what the routine already says proposes nothing.
TEST(gym_a_proposal_that_changes_nothing_is_refused_rather_than_shown_to_a_lifter) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);
  const Json::Value document = body(me.call("list_routines", Json::Value(Json::objectValue)))
                                   ["routines"][0]["entries"];

  const ToolResult refused = me.propose("prop_00000001", "rt_00000001", document);

  CHECK(refused.isError);
  CHECK(message(refused).find("already says") != std::string::npos);
  CHECK_EQ(stored("select id from gym_proposals"), std::vector<std::string>{});
}

// The read receipt rides in the tool's own reply: the server counts the rows it served.

TEST(gym_a_workout_read_answers_with_the_rows_it_served) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'700'000'000'000);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'300'000);
  me.logSet("ses_00000001", "set_00000002", "bench-press", 82.5, 5, 1'700'000'600'000);
  me.finish("ses_00000001", 1'700'000'900'000);

  Json::Value args(Json::objectValue);
  args["sessionId"] = "ses_00000001";
  const Json::Value read = body(me.call("get_session", args))["read"];

  CHECK_EQ(read["sets"].asInt(), 2);
  CHECK_EQ(read["sessions"].asInt(), 1);
  CHECK_EQ(read["weeks"].asInt(), 1);
}

// A page NAMES workouts and counts their sets; it hands over no set rows, so it claims none.
TEST(gym_a_log_page_claims_the_workouts_it_named_and_not_their_sets) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_00000001", 1'700'000'000'000);
  me.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'300'000);
  me.finish("ses_00000001", 1'700'000'900'000);
  h.clock.now = 1'700'600'000'000;
  me.start("ses_00000002", 1'700'600'000'000);
  me.logSet("ses_00000002", "set_00000002", "back-squat", 100, 5, 1'700'600'300'000);
  me.finish("ses_00000002", 1'700'600'900'000);

  const Json::Value read = body(me.call("list_sessions", Json::Value(Json::objectValue)))["read"];

  CHECK_EQ(read["sets"].asInt(), 0);
  CHECK_EQ(read["sessions"].asInt(), 2);
  CHECK_EQ(read["weeks"].asInt(), 2);  // a Tuesday and the Tuesday after: two Monday-to-Monday weeks
}

// The catalog and the program are not the log, so they make no claim at all.
TEST(gym_a_read_that_served_no_log_rows_says_nothing_about_what_it_read) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};
  CHECK_FALSE(body(me.call("list_exercises", Json::Value(Json::objectValue))).isMember("read"));
  CHECK_FALSE(body(me.call("list_routines", Json::Value(Json::objectValue))).isMember("read"));
}

// Provenance is a column and not a fork: the same tool through the MCP door mints a proposal that says so.
TEST(gym_a_proposal_minted_over_mcp_carries_the_mcp_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  createPushA(h);

  const ToolResult minted =
      me.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", straight(5, 3, 87.5)));

  CHECK_FALSE(minted.isError);
  CHECK_EQ(body(minted)["proposal"]["source"]["door"].asString(), std::string("mcp"));
}

// The retry identity holds against what a phone did since: its fix stands, and the set it deleted stays deleted.
TEST(gym_log_sets_is_atomic_ordered_and_keeps_original_retry_identity) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_batch001", h.clock.now - 10000);
  Json::Value args = parse(R"({"sessionId":"ses_batch001","sets":[{"id":"set_batch001","exerciseId":"bench-press","weightKg":80,"reps":5,"completedAt":1},{"id":"set_batch002","exerciseId":"bench-press","weightKg":82.5,"reps":4,"completedAt":1}]})");
  for (Json::Value& set : args["sets"]) set["completedAt"] = Json::UInt64(h.clock.now - 1000);
  Json::Value invalid = args;
  invalid["sets"][1]["exerciseId"] = "absent";
  const ToolResult rejected = me.call("log_sets", invalid);
  CHECK(rejected.isError);
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
  CHECK_EQ(stored("select id from gym_write_receipts where kind = 'set'"), std::vector<std::string>{});
  CHECK_EQ(message(rejected), std::string("log_sets: sets[1] (set_batch002): no movement has that id. Call list_exercises for the catalog, or create_exercise to add one. No changes from this batch were committed."));
  const ToolResult result = me.call("log_sets", args);
  CHECK_FALSE(result.isError);
  CHECK_EQ(body(result), parse(R"({"sessionId":"ses_batch001","applied":true,"replayed":false,"sessionDeleted":false,"sets":[{"id":"set_batch001","setNumber":1,"status":"created"},{"id":"set_batch002","setNumber":2,"status":"created"}]})"));
  CHECK_EQ(result.structured, result.payload);
  Json::Value fix(Json::objectValue);
  fix["reps"] = 3;
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("set", "set_batch001", fix)}));
  h.kill(h.user, "set", "set_batch002");
  const ToolResult replay = me.call("log_sets", args);
  CHECK_EQ(body(replay), parse(R"({"sessionId":"ses_batch001","applied":true,"replayed":true,"sessionDeleted":false,"sets":[{"id":"set_batch001","setNumber":1,"status":"replayed"},{"id":"set_batch002","status":"deleted"}]})"));
  const std::vector<Set> standing{Set{SetId{"set_batch001"}, SessionId{"ses_batch001"}, ExerciseId{"bench-press"}, 1,
                                      80, 3, SetKind::working, std::nullopt, "", h.clock.now - 1000}};
  CHECK_EQ(h.training.detail(h.user, SessionId{"ses_batch001"})->sets, standing);
  args["sets"][0]["reps"] = 3;
  CHECK(me.call("log_sets", args).isError);
  CHECK_EQ(h.training.detail(h.user, SessionId{"ses_batch001"})->sets, standing);
}

TEST(gym_log_sets_rejects_invalid_final_rows_duplicates_and_foreign_sessions) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  me.start("ses_batch001", h.clock.now - 10000);
  Json::Value args = parse(R"({"sessionId":"ses_batch001","sets":[{"id":"set_batch001","exerciseId":"bench-press","weightKg":80,"reps":5,"completedAt":1},{"id":"set_batch002","exerciseId":"bench-press","weightKg":82.5,"reps":4,"completedAt":1}]})");
  for (Json::Value& set : args["sets"]) set["completedAt"] = Json::UInt64(h.clock.now - 1000);
  for (const char* field : {"reps", "weightKg", "completedAt"}) {
    Json::Value bad = args;
    bad["sets"][1][field] = field == std::string("weightKg") ? Json::Value(80.001) : Json::Value(0);
    CHECK(me.call("log_sets", bad).isError);
    CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
  }
  Json::Value duplicate = args;
  duplicate["sets"][1]["id"] = "set_batch001";
  CHECK(me.call("log_sets", duplicate).isError);
  CHECK(them.call("log_sets", args).isError);
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
}

TEST(gym_import_session_is_independent_of_the_live_workout_and_never_restores_a_deleted_import) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  me.start("ses_live0001", h.clock.now);
  const std::optional<Session> live = h.repo.log.session(h.user, SessionId{"ses_live0001"});
  REQUIRE(live.has_value());
  Json::Value args = parse(R"({"id":"ses_import01","startedAt":1000,"finishedAt":3000,"sets":[{"id":"set_import01","exerciseId":"bench-press","weightKg":80,"reps":5,"completedAt":2000}]})");
  const ToolResult imported = me.call("import_session", args);
  CHECK_FALSE(imported.isError);
  CHECK_EQ(body(imported), parse(R"({"sessionId":"ses_import01","applied":true,"imported":true,"replayed":false,"sessionDeleted":false,"sets":[{"id":"set_import01","setNumber":1,"status":"created"}]})"));
  CHECK_EQ(h.repo.log.open(h.user), live);
  CHECK_FALSE(me.call("import_session", args).isError);
  CHECK_EQ(stored("select id from gym_sessions order by id"),
           (std::vector<std::string>{"ses_import01", "ses_live0001"}));
  CHECK(h.door.discard(h.user, SessionId{"ses_import01"}) == DiscardOutcome::done);
  CHECK_EQ(body(me.call("import_session", args)), parse(R"({"sessionId":"ses_import01","applied":true,"imported":false,"replayed":true,"sessionDeleted":true,"sets":[{"id":"set_import01","status":"deleted"}]})"));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{"ses_live0001"});
  args["sets"][0]["reps"] = 6;
  CHECK(me.call("import_session", args).isError);
  CHECK_EQ(h.repo.log.open(h.user), live);
}

TEST(gym_selected_reads_preserve_order_missing_ids_scopes_and_structured_read_tallies) {
  MemoryHarness h;
  const Agent me{h.tools, uid()};
  const Agent them{h.tools, uid("u2")};
  h.repo.db.seedSession(Session{SessionId{"ses_batch001"}, uid(), 1000, 3000});
  h.repo.db.seedSession(Session{SessionId{"ses_batch002"}, uid(), 4000, 6000});
  const ToolResult result = me.call("get_sessions", parse(R"({"sessionIds":["ses_batch002","missing","ses_batch001"]})"));
  CHECK_FALSE(result.isError);
  CHECK_EQ(result.structured, result.payload);
  CHECK_EQ(body(result)["sessions"][0]["session"]["id"].asString(), std::string("ses_batch002"));
  CHECK_EQ(body(result)["sessions"][1]["session"]["id"].asString(), std::string("ses_batch001"));
  CHECK_EQ(body(result)["missingSessionIds"], parse(R"(["missing"])"));
  CHECK_EQ(body(result)["read"]["sessions"].asInt(), 2);
  CHECK_EQ(body(them.call("get_sessions", parse(R"({"sessionIds":["ses_batch001"]})"))), parse(R"({"sessions":[],"missingSessionIds":["ses_batch001"]})"));
  CHECK(me.call("get_sessions", parse(R"({"sessionIds":["ses_batch001","ses_batch001"]})")).isError);
  CHECK_EQ(body(me.call("get_last_times", parse(R"({"exerciseIds":["bench-press","missing","back-squat"]})"))), parse(R"({"exercises":[{"exerciseId":"bench-press","trained":false},{"exerciseId":"back-squat","trained":false}],"missingExerciseIds":["missing"]})"));
}

TEST(gym_imported_ids_stay_spent_through_single_tool_paths_after_deletion) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Json::Value args = parse(R"({"id":"ses_import01","startedAt":1000,"finishedAt":3000,"sets":[{"id":"set_import01","exerciseId":"bench-press","weightKg":80,"reps":5,"completedAt":2000}]})");
  CHECK_FALSE(me.call("import_session", args).isError);
  CHECK(h.door.discard(h.user, SessionId{"ses_import01"}) == DiscardOutcome::done);
  CHECK_EQ(message(me.start("ses_import01", h.clock.now)),
      std::string("start_session: that workout id is already spent. Inspect list_sessions to reconcile the log; "
                  "preserve deleted workouts. Retry only with the original id and body. "
                  "Use a fresh id only when the user asks to record a new workout."));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{});
  CHECK_FALSE(me.start("ses_fresh001", h.clock.now).isError);
  CHECK(me.logSet("ses_fresh001", "set_import01", "bench-press", 80, 5, h.clock.now).isError);
  CHECK_EQ(stored("select id from gym_sets"), std::vector<std::string>{});
  CHECK(body(me.call("import_session", args))["sessionDeleted"].asBool());
}

TEST(gym_all_five_reads_capture_only_the_session_scope_they_actually_served) {
  MemoryHarness h;
  const Session session{SessionId{"ses_evidence1"}, uid(), 1'700'000'000'000,
                        1'700'000'900'000, std::nullopt, PlanSnapshot{"Push A", {}}};
  h.repo.db.sessions.push_back(session);
  h.repo.db.sets = {
      Set{SetId{"set_evidence1"}, session.id, ExerciseId{"bench-press"}, 1, 20, 5,
          SetKind::warmup, std::nullopt, "", 1'700'000'100'000},
      Set{SetId{"set_evidence2"}, session.id, ExerciseId{"bench-press"}, 2, 80, 5,
          SetKind::working, std::nullopt, "", 1'700'000'200'000},
      Set{SetId{"set_evidence3"}, session.id, ExerciseId{"back-squat"}, 1, 100, 5,
          SetKind::working, std::nullopt, "", 1'700'000'200'000}};
  AskTools hands{h.tools, ThreadId{"thr_evidence1"}};
  const ToolCaller caller{uid(), ToolScope::everything()};
  const std::vector<std::pair<std::string, Json::Value>> calls = {
      {"list_sessions", parse("{}")},
      {"get_session", parse(R"({"sessionId":"ses_evidence1"})")},
      {"last_time", parse(R"({"exerciseId":"bench-press"})")},
      {"get_sessions", parse(R"({"sessionIds":["ses_evidence1"]})")},
      {"get_last_times", parse(R"({"exerciseIds":["back-squat","bench-press"]})")}};
  for (const auto& [name, args] : calls) CHECK_FALSE(hands.callTool(name, args, caller).isError);

  const WorkoutObservation workout{session, 2, 900};
  CHECK_EQ(hands.read().tally(), (ReadTally{3, 1, 1}));
  CHECK_EQ(hands.read().observations(), (std::vector<SessionObservation>{
      {"list_sessions", session, ReadCoverage::summary, 0, workout},
      {"get_session", session, ReadCoverage::session, 3, workout},
      {"last_time", session, ReadCoverage::movement, 1, std::nullopt, ExerciseId{"bench-press"}},
      {"get_sessions", session, ReadCoverage::session, 3, workout},
      {"get_last_times", session, ReadCoverage::movement, 1, std::nullopt, ExerciseId{"back-squat"}},
      {"get_last_times", session, ReadCoverage::movement, 1, std::nullopt, ExerciseId{"bench-press"}}}));
  CHECK_EQ(hands.steps(), (std::vector<AskStep>{{"list_sessions", false}, {"get_session", false},
      {"last_time", false}, {"get_sessions", false}, {"get_last_times", false}}));

  h.repo.db.sets[1].weightKg = 90;
  h.repo.db.sessions[0].plan->routineName = "Corrected";
  CHECK_FALSE(hands.callTool("get_session", calls[1].second, caller).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{3, 1, 1}));
  REQUIRE_EQ(hands.read().observations().size(), 7u);
  CHECK_EQ(hands.read().observations()[1].workout->tonnageKg, 900);
  CHECK_EQ(hands.read().observations()[6].workout->tonnageKg, 950);
  CHECK_EQ(hands.read().observations()[1].routine, std::optional<std::string>{"Push A"});
  CHECK_EQ(hands.read().observations()[6].routine, std::optional<std::string>{"Corrected"});
}

TEST(gym_refused_oversized_batches_leave_no_evidence_from_unserved_rows) {
  MemoryHarness h;
  const Session session{SessionId{"ses_evidence1"}, uid(), 1'700'000'000'000, 1'700'000'900'000};
  h.repo.db.sessions.push_back(session);
  for (int index = 1; index <= 50; ++index)
    h.repo.db.sets.emplace_back(SetId{"set_evidence" + std::to_string(index)}, session.id,
        ExerciseId{"bench-press"}, index, 80, 5, SetKind::working, std::nullopt,
        std::string(4000, 'x'), 1'700'000'100'000);
  AskTools hands{h.tools, ThreadId{"thr_evidence1"}};
  const ToolCaller caller{uid(), ToolScope::everything()};

  CHECK(hands.callTool("get_sessions", parse(R"({"sessionIds":["ses_evidence1"]})"), caller).isError);
  CHECK(hands.callTool("get_last_times", parse(R"({"exerciseIds":["bench-press"]})"), caller).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));
  CHECK(hands.read().observations().empty());
  CHECK_EQ(hands.steps(), (std::vector<AskStep>{{"get_sessions", true}, {"get_last_times", true}}));
}

TEST(gym_failed_and_foreign_reads_cannot_contribute_observations) {
  MemoryHarness h;
  h.repo.db.sessions.emplace_back(SessionId{"ses_evidence1"}, UserId{"u2"}, 1000, 3000);
  AskTools hands{h.tools, ThreadId{"thr_evidence1"}};
  const ToolCaller caller{uid(), ToolScope::everything()};
  const ToolResult foreign = hands.callTool("get_session", with("sessionId", "ses_evidence1"), caller);
  const ToolResult absent = hands.callTool("get_session", with("sessionId", "ses_absent01"), caller);
  CHECK(foreign.isError);
  CHECK_EQ(foreign.payload, absent.payload);
  CHECK_EQ(foreign.content, absent.content);
  CHECK(hands.callTool("get_sessions", parse(R"({"sessionIds":["ses_evidence1","ses_evidence1"]})"), caller).isError);
  CHECK_FALSE(hands.callTool("get_sessions", parse(R"({"sessionIds":["ses_evidence1"]})"), caller).isError);
  CHECK_FALSE(hands.callTool("last_time", with("exerciseId", "bench-press"), caller).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 0, 0}));
  CHECK(hands.read().observations().empty());
  CHECK_EQ(hands.steps(), (std::vector<AskStep>{{"get_session", true}, {"get_session", true},
      {"get_sessions", true}, {"get_sessions", false}, {"last_time", false}}));
}

TEST(gym_equal_start_times_keep_distinct_session_evidence_in_requested_order) {
  MemoryHarness h;
  const Session first{SessionId{"ses_evidence1"}, uid(), 1'700'000'000'000, 1'700'000'900'000};
  const Session second{SessionId{"ses_evidence2"}, uid(), first.startedAtMs, first.finishedAtMs};
  h.repo.db.sessions = {first, second};
  AskTools hands{h.tools, ThreadId{"thr_evidence1"}};
  const ToolCaller caller{uid(), ToolScope::everything()};
  const Json::Value args = parse(R"({"sessionIds":["ses_evidence2","ses_evidence1"]})");
  CHECK_FALSE(hands.callTool("get_sessions", args, caller).isError);
  CHECK_FALSE(hands.callTool("get_sessions", args, caller).isError);
  CHECK_EQ(hands.read().tally(), (ReadTally{0, 2, 1}));
  const SessionObservation a{"get_sessions", first, ReadCoverage::session, 0,
                              WorkoutObservation{first, 0, 0}};
  const SessionObservation b{"get_sessions", second, ReadCoverage::session, 0,
                              WorkoutObservation{second, 0, 0}};
  CHECK_EQ(hands.read().observations(), (std::vector<SessionObservation>{b, a, b, a}));
}

// save_note only appends below the lifter's own note, and its receipt outlives a delete on the phone.
TEST(gym_save_note_is_append_only_owner_scoped_and_granted_as_a_write) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  const Agent them{h.tools, h.other};
  const auto input = parse(R"({"id":"note_save001","title":"Schedule","body":"I train on Monday and Thursday."})");
  Json::Value byHand(Json::objectValue);
  byHand["title"] = "Priority";
  byHand["body"] = "Keep this first.";
  byHand["ord"] = sync::between(std::nullopt, std::nullopt);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("note", "note_hand001", byHand, true)}));
  CompositeToolHost host({ToolModule{h.tools, "Gym tools"}});
  const auto denied = host.callTool("save_note", input, ToolCaller{h.user, ToolScope({{"gym", Access::read}})});
  CHECK(denied.isError);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{"note_hand001"});
  const auto saved = me.call("save_note", input);
  REQUIRE(!saved.isError);
  Json::Value expected(Json::objectValue);
  expected["saved"] = true;
  expected["note"] = toJson(Note{NoteId{"note_save001"}, h.user, "Schedule", "I train on Monday and Thursday.", 1, h.clock.now});
  CHECK_EQ(body(saved), expected);
  CHECK_EQ(body(me.call("save_note", input)), expected);
  CHECK(them.call("save_note", input).isError);
  auto changed = input;
  changed["body"] = "A different idea.";
  CHECK(me.call("save_note", changed).isError);
  CHECK_EQ(stored("select id from gym_notes order by id"),
           (std::vector<std::string>{"note_hand001", "note_save001"}));
  CHECK_EQ(h.repo.notes.notes(h.user)[0].body, std::string("Keep this first."));
  h.kill(h.user, "note", "note_save001");
  CHECK_EQ(body(me.call("save_note", input)), expected);
  CHECK_EQ(stored("select id from gym_notes"), std::vector<std::string>{"note_hand001"});
}

TEST(gym_import_session_crossing_a_finished_workout_is_refused_naming_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Agent me{h.tools, h.user};
  REQUIRE(!me.call("import_session", parse(R"({"id":"ses_before01","startedAt":2000,"finishedAt":4000,"sets":[]})")).isError);
  const Json::Value args = parse(R"({"id":"ses_import01","startedAt":1000,"finishedAt":3000,"sets":[]})");

  const ToolResult refused = me.call("import_session", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("import_session: those times cross workout ses_before01, already in the log; one visit is "
                       "one workout, so read it with get_sessions before choosing other times. No changes from "
                       "this batch were committed."));
  CHECK_EQ(stored("select id from gym_sessions"), std::vector<std::string>{"ses_before01"});
}
