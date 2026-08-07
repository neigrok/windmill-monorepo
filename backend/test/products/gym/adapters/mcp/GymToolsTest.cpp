#include "products/gym/adapters/mcp/GymTools.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::gym;
using namespace wm::gym::fake;

namespace {

// Deliberately NOT the api origin: a share becomes a page in the browser app, and the two are one
// host in production, which is what hid the bug where the tool handed out the JSON route.
const char* kAppBase = "https://windmill.works";

// One in-memory store, one hand-driven clock, the real service, the real tools. Nothing here is a
// fake of gym's own logic: the tools go through LogService exactly as the HTTP handlers do, so a
// rule that moved would break both suites rather than one.
struct Harness {
  FakeTrainingRepository repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  LogService service{repo, clock, tokens};
  GymTools tools{service, kAppBase};

  Harness() {
    repo.seed(benchPress());
    repo.seed(backSquat());
  }

  ToolResult call(const char* name, Json::Value args, const char* user = "u1") {
    // The grant is settled above these tools, by CompositeToolHost — every call that reaches a
    // product host has already been approved, so the scope here is the account-wide one.
    return tools.callTool(name, args, ToolCaller{UserId{user}, ToolScope::everything()});
  }

  ToolResult start(const char* id, std::uint64_t startedAtMs, const char* user = "u1") {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["startedAt"] = Json::Value::UInt64(startedAtMs);
    return call("start_session", args, user);
  }

  ToolResult logSet(const char* session, const char* id, const char* exercise, double weightKg,
                    int reps, std::uint64_t completedAtMs, const char* user = "u1") {
    Json::Value args(Json::objectValue);
    args["sessionId"] = session;
    args["id"] = id;
    args["exerciseId"] = exercise;
    args["weightKg"] = weightKg;
    args["reps"] = reps;
    args["completedAt"] = Json::Value::UInt64(completedAtMs);
    return call("log_set", args, user);
  }

  ToolResult finish(const char* session, std::uint64_t finishedAtMs, const char* user = "u1") {
    Json::Value args(Json::objectValue);
    args["sessionId"] = session;
    args["finishedAt"] = Json::Value::UInt64(finishedAtMs);
    return call("finish_session", args, user);
  }
};

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

// A product's published catalog with no service behind it — enough to prove what the composite does
// at construction, which is the only thing a name collision could ever break.
struct CatalogOnly : ToolHost {
  std::vector<ToolDeclaration> catalog;
  explicit CatalogOnly(std::vector<ToolDeclaration> declared) : catalog(std::move(declared)) {}
  std::vector<ToolDeclaration> declareTools() const override { return catalog; }
  ToolResult callTool(const std::string&, const Json::Value&, const ToolCaller&) override {
    return ToolResult::failure("not dispatched in this test");
  }
};

}

// ---- the classification, which IS the gate ---------------------------------------------------

// Pinned whole and in order, because this table is the permission model: a tool that slipped from
// delete to write would hand out destructive reach nobody approved, and it would do it silently.
// Reads first, then writes, then deletes — so a narrower grant sees a prefix rather than holes.
TEST(gym_catalog_names_the_grant_level_that_reaches_every_tool) {
  CHECK_EQ(classified(gymToolCatalog()),
           (std::vector<std::string>{
               "list_exercises gym:read", "list_sessions gym:read", "get_session gym:read",
               "last_time gym:read", "list_routines gym:read", "get_stats gym:read",
               "start_session gym:write", "log_set gym:write", "finish_session gym:write",
               "save_routine gym:write", "create_exercise gym:write", "share_session gym:write",
               "discard_session gym:delete", "delete_routine gym:delete", "revoke_share gym:delete"}));
}

TEST(gym_tools_list_carries_exactly_the_levels_a_grant_named) {
  Harness h;

  const std::vector<std::string> reads{"list_exercises", "list_sessions", "get_session",
                                       "last_time",      "list_routines", "get_stats"};
  const std::vector<std::string> writes{"start_session", "log_set",         "finish_session",
                                        "save_routine",  "create_exercise", "share_session"};
  const std::vector<std::string> deletes{"discard_session", "delete_routine", "revoke_share"};

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
  Harness h;

  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("roadmap:read roadmap:write")})),
           (std::vector<std::string>{}));
}

// The one thing a second product can break at boot, proved against the REAL roadmap catalog rather
// than a fake of it: a duplicate tool name is a construction failure, so a collision would take the
// server down at start-up instead of answering calls from whichever product registered first.
TEST(gym_and_roadmap_names_coexist_in_one_composite) {
  Harness h;
  CatalogOnly roadmap(roadmapToolCatalog());

  CompositeToolHost surface(std::vector<ToolModule>{{roadmap, "roadmap paragraph"},
                                                    {h.tools, gymInstructions()}});

  CHECK_EQ(surface.products(), (std::vector<std::string>{"roadmap", "gym"}));
  CHECK_EQ(namesIn(surface.listTools(ToolCaller{uid(), parseToolScope("gym:read")})),
           (std::vector<std::string>{"list_exercises", "list_sessions", "get_session", "last_time",
                                     "list_routines", "get_stats"}));
  CHECK_EQ(static_cast<int>(surface.declareTools().size()),
           static_cast<int>(roadmapToolCatalog().size() + gymToolCatalog().size()));
}

// The schemas publish three vocabularies; the domain refuses against them. Round-tripping every word
// is what stops the two from drifting when a pattern or a set kind is added to one and not the other.
TEST(gym_catalog_publishes_the_vocabularies_the_domain_actually_parses) {
  for (const char* word : kPatterns) CHECK_EQ(toString(parsePattern(word)), std::string(word));
  for (const char* word : kEquipment) CHECK_EQ(toString(parseEquipment(word)), std::string(word));
  for (const char* word : kSetKinds) CHECK_EQ(toString(parseSetKind(word)), std::string(word));
  CHECK_EQ(kPatterns.size(), std::size_t{7});
  CHECK_EQ(kEquipment.size(), std::size_t{6});
  CHECK_EQ(kSetKinds.size(), std::size_t{4});
}

// ---- every tool acts as the caller -----------------------------------------------------------

TEST(gym_tools_read_and_write_only_the_callers_own_log) {
  Harness h;
  h.start("ses_00000001", h.clock.now);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);

  const ToolResult stranger = h.call("get_session", with("sessionId", "ses_00000001"), "u2");
  CHECK(stranger.isError);
  CHECK_EQ(message(stranger),
           std::string("get_session: no workout of yours has that id. Call list_sessions for the "
                       "ids you own."));

  const ToolResult theirs = h.call("list_sessions", Json::Value(Json::objectValue), "u2");
  CHECK_FALSE(theirs.isError);
  CHECK_EQ(body(theirs)["sessions"].size(), 0u);

  const ToolResult mine = h.call("get_session", with("sessionId", "ses_00000001"));
  CHECK_FALSE(mine.isError);
  CHECK_EQ(body(mine)["sets"].size(), 1u);
}

// A stranger's write is refused by the same one fact its read is: never "another account's".
TEST(gym_a_write_into_someone_elses_workout_is_refused_as_absent) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      h.logSet("ses_00000001", "set_00000009", "bench-press", 80, 5, h.clock.now + 60'000, "u2");

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: no workout of yours has that id. Call list_sessions for the ids "
                       "you own."));
  CHECK_EQ(h.repo.sets.size(), std::size_t{0});
}

// ---- client-minted ids: a replay is the stored row, never a second one -----------------------

TEST(gym_a_replayed_set_answers_with_the_row_already_stored) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult first =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);
  const ToolResult replay =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);

  CHECK_FALSE(replay.isError);
  CHECK_EQ(body(replay), body(first));
  CHECK_EQ(body(replay)["setNumber"].asInt(), 1);
  CHECK_EQ(h.repo.sets.size(), std::size_t{1});
}

TEST(gym_a_replayed_start_answers_with_the_workout_already_open) {
  Harness h;
  const ToolResult first = h.start("ses_00000001", h.clock.now);

  const ToolResult replay = h.start("ses_00000001", h.clock.now);

  CHECK_FALSE(replay.isError);
  CHECK_EQ(body(replay), body(first));
  CHECK_EQ(h.repo.sessions.size(), std::size_t{1});
}

TEST(gym_a_set_id_spent_in_another_workout_is_refused_by_name) {
  Harness h;
  h.start("ses_00000001", h.clock.now);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 60'000);
  h.finish("ses_00000001", h.clock.now + 120'000);
  h.start("ses_00000002", h.clock.now + 200'000);

  const ToolResult refused =
      h.logSet("ses_00000002", "set_00000001", "bench-press", 82.5, 5, h.clock.now + 260'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: that set id is already spent on a set in another workout. Mint a "
                       "different one and send it again."));
}

// ---- the refusals, in words a model can act on -----------------------------------------------

TEST(gym_a_set_into_a_finished_workout_says_to_open_a_new_one) {
  Harness h;
  h.start("ses_00000001", h.clock.now);
  h.finish("ses_00000001", h.clock.now + 60'000);

  const ToolResult refused =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 5, h.clock.now + 30'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: that workout is finished, so no new set can be added to it. Open a "
                       "new one with start_session."));
}

TEST(gym_a_set_naming_no_movement_points_at_the_catalog) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      h.logSet("ses_00000001", "set_00000001", "zercher-squat", 80, 5, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("log_set: no movement has that id. Call list_exercises for the catalog, or "
                       "create_exercise to add one."));
}

TEST(gym_a_start_that_refuses_to_join_says_what_to_do_about_the_open_workout) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000002";
  args["startedAt"] = Json::Value::UInt64(h.clock.now + 1000);
  args["joinOpenSession"] = false;
  const ToolResult refused = h.call("start_session", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: a workout of yours is already open and this call said it "
                       "would not join one. Close it with finish_session first, or drop "
                       "joinOpenSession to log into it."));
}

TEST(gym_a_start_naming_no_routine_is_refused_rather_than_started_ad_hoc) {
  Harness h;

  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000001";
  args["startedAt"] = Json::Value::UInt64(h.clock.now);
  args["routineId"] = "rt_00000009";
  const ToolResult refused = h.call("start_session", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: no routine of yours has that id, so this workout was not "
                       "started rather than started with no plan. Call list_routines, or leave "
                       "routineId out for an ad-hoc workout."));
  CHECK_EQ(h.repo.sessions.size(), std::size_t{0});
}

TEST(gym_a_finish_before_the_start_is_refused_and_says_where_to_read_the_start) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult refused = h.finish("ses_00000001", h.clock.now - 1000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("finish_session: that workout cannot end at that instant — a workout ends at "
                       "or after it began. Read its `startedAt` with get_session."));
}

// The domain's own sentence, forwarded verbatim: the browser edge flattens every one of these into
// "could not read that set", which tells an agent nothing about which field to fix.
TEST(gym_a_value_the_domain_refuses_reaches_the_agent_as_the_domains_own_sentence) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 0, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("log_set: reps out of range"));
  CHECK_EQ(h.repo.sets.size(), std::size_t{0});
}

TEST(gym_a_missing_handle_names_the_argument_and_the_tool_that_lists_it) {
  Harness h;

  const ToolResult refused = h.call("get_session", Json::Value(Json::objectValue));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("get_session: missing required argument \"sessionId\". Call list_sessions "
                       "for the ids you own."));
}

TEST(gym_a_name_this_surface_does_not_serve_points_back_at_tools_list) {
  Harness h;

  const ToolResult refused = h.call("bench_press_harder", Json::Value(Json::objectValue));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("bench_press_harder: no such gym tool — call tools/list for the surface this "
                       "connection may use."));
}

TEST(gym_arguments_that_are_not_an_object_are_named_by_type) {
  Harness h;

  const ToolResult refused = h.call("list_sessions", Json::Value("ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("list_sessions: arguments must be a JSON object of this tool's named "
                       "arguments, got a string"));
}

// ---- the reads --------------------------------------------------------------------------------

TEST(gym_the_log_reads_newest_first_and_pages_on_both_halves_of_the_cursor) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.finish("ses_00000001", 1'060'000);
  h.start("ses_00000002", 2'000'000);
  h.finish("ses_00000002", 2'060'000);

  Json::Value page(Json::objectValue);
  page["limit"] = 1;
  const ToolResult first = h.call("list_sessions", page);
  REQUIRE_EQ(body(first)["sessions"].size(), 1u);
  CHECK_EQ(body(first)["sessions"][0]["id"].asString(), std::string("ses_00000002"));

  Json::Value next(Json::objectValue);
  next["before"] = Json::Value::UInt64(2'000'000);
  next["beforeId"] = "ses_00000002";
  const ToolResult second = h.call("list_sessions", next);
  REQUIRE_EQ(body(second)["sessions"].size(), 1u);
  CHECK_EQ(body(second)["sessions"][0]["id"].asString(), std::string("ses_00000001"));
}

TEST(gym_a_page_cursor_id_with_no_instant_beside_it_is_refused) {
  Harness h;

  const ToolResult refused = h.call("list_sessions", with("beforeId", "ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("list_sessions: \"beforeId\" needs \"before\" beside it — an id with no "
                       "instant names no row in the page order."));
}

TEST(gym_the_session_read_carries_the_finish_readout_only_when_it_is_asked_for) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  h.finish("ses_00000001", 1'120'000);

  const ToolResult plain = h.call("get_session", with("sessionId", "ses_00000001"));
  CHECK_FALSE(body(plain).isMember("review"));

  Json::Value args(Json::objectValue);
  args["sessionId"] = "ses_00000001";
  args["review"] = true;
  const ToolResult withReview = h.call("get_session", args);
  REQUIRE(body(withReview).isMember("review"));
  CHECK_EQ(body(withReview)["review"]["stats"]["workingSets"].asInt(), 1);
  CHECK_EQ(body(withReview)["review"]["stats"]["durationMs"].asUInt64(), 120'000u);
}

TEST(gym_last_time_answers_a_first_ever_movement_with_the_movement_alone) {
  Harness h;

  const ToolResult never = h.call("last_time", with("exerciseId", "bench-press"));
  CHECK_FALSE(never.isError);
  CHECK_EQ(body(never)["exerciseId"].asString(), std::string("bench-press"));
  CHECK_FALSE(body(never).isMember("sets"));

  const ToolResult unknown = h.call("last_time", with("exerciseId", "zercher-squat"));
  CHECK(unknown.isError);
  CHECK_EQ(message(unknown),
           std::string("last_time: no movement has that id. Call list_exercises for the catalog, or "
                       "create_exercise to add one."));
}

TEST(gym_last_time_answers_with_the_sets_of_the_workout_that_held_them) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  h.logSet("ses_00000001", "set_00000002", "back-squat", 105, 3, 1'120'000);
  h.finish("ses_00000001", 1'180'000);

  const ToolResult last = h.call("last_time", with("exerciseId", "back-squat"));

  CHECK_FALSE(last.isError);
  CHECK_EQ(body(last)["session"]["id"].asString(), std::string("ses_00000001"));
  REQUIRE_EQ(body(last)["sets"].size(), 2u);
  CHECK_EQ(body(last)["sets"][1]["weightKg"].asDouble(), 105.0);
}

TEST(gym_the_catalog_read_carries_the_seeds_and_the_callers_own_movements) {
  Harness h;
  Json::Value made(Json::objectValue);
  made["id"] = "ex_00000001";
  made["name"] = "Zercher Squat";
  made["pattern"] = "squat";
  made["equipment"] = "barbell";
  const ToolResult created = h.call("create_exercise", made);
  CHECK_FALSE(created.isError);
  CHECK_EQ(body(created)["stepKg"].asDouble(), 2.5);   // the equipment's own default
  CHECK(body(created)["custom"].asBool());

  const ToolResult mine = h.call("list_exercises", Json::Value(Json::objectValue));
  CHECK_EQ(mine.payload["exercises"].size(), 3u);
  const ToolResult theirs = h.call("list_exercises", Json::Value(Json::objectValue), "u2");
  CHECK_EQ(theirs.payload["exercises"].size(), 2u);
}

TEST(gym_a_movement_id_that_is_a_seeds_slug_is_refused_without_saying_whose) {
  Harness h;
  Json::Value made(Json::objectValue);
  made["id"] = "bench-press";
  made["name"] = "Bench Press";
  made["pattern"] = "press";
  made["equipment"] = "barbell";

  const ToolResult refused = h.call("create_exercise", made);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_exercise: that movement id is already spent. Mint a different one "
                       "and send it again — and read list_exercises first, in case the movement "
                       "itself is already there under another id."));
}

// The first close is permanent: a finish sent twice answers with the end the workout already has,
// so a retry can never move a workout's end instant.
TEST(gym_a_second_finish_answers_with_the_end_the_workout_already_has) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  const ToolResult first = h.finish("ses_00000001", 1'060'000);

  const ToolResult again = h.finish("ses_00000001", 1'120'000);

  CHECK_FALSE(again.isError);
  CHECK_EQ(body(again), body(first));
  CHECK_EQ(body(again)["finishedAt"].asUInt64(), 1'060'000u);
}

TEST(gym_stats_narrow_to_one_movement_and_keep_the_weeks) {
  Harness h;
  h.start("ses_00000001", 1'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'000'060'000);
  h.logSet("ses_00000001", "set_00000002", "bench-press", 80, 5, 1'000'120'000);
  h.finish("ses_00000001", 1'000'180'000);

  const ToolResult everything = h.call("get_stats", Json::Value(Json::objectValue));
  CHECK_EQ(body(everything)["movements"].size(), 2u);

  const ToolResult narrowed = h.call("get_stats", with("exerciseId", "back-squat"));
  REQUIRE_EQ(body(narrowed)["movements"].size(), 1u);
  CHECK_EQ(body(narrowed)["movements"][0]["exerciseId"].asString(), std::string("back-squat"));
  CHECK_EQ(body(narrowed)["weeks"].size(), body(everything)["weeks"].size());
}

// ---- the plan ---------------------------------------------------------------------------------

// A schema is a promise about what the write will accept, so every bound in it has to be the
// DOMAIN's. This one advertised targetReps up to 500 and restSeconds from 0 to 3600 while Routine
// refuses outside 1–100 and 15–900: an agent that filled a line to the letter of the published
// schema had the WHOLE document refused over a value the surface itself invited.
TEST(gym_the_routine_entry_schema_publishes_the_bounds_the_domain_actually_keeps) {
  Json::Value entries(Json::nullValue);
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "save_routine")
      entries = tool.descriptor["inputSchema"]["properties"]["entries"];
  REQUIRE(entries.isObject());
  const Json::Value& fields = entries["items"]["properties"];

  CHECK_EQ(fields["targetSets"]["minimum"].asInt(), 1);
  CHECK_EQ(fields["targetSets"]["maximum"].asInt(), 20);
  CHECK_EQ(fields["targetReps"]["minimum"].asInt(), 1);
  CHECK_EQ(fields["targetReps"]["maximum"].asInt(), 100);
  CHECK_EQ(fields["restSeconds"]["minimum"].asInt(), 15);
  CHECK_EQ(fields["restSeconds"]["maximum"].asInt(), 900);
  // The document's own size is published beside its fields' values, because the constructor has
  // always refused both ends of it and the description already said so in prose.
  CHECK_EQ(entries["minItems"].asInt(), 1);
  CHECK_EQ(entries["maxItems"].asInt(), kMaxRoutineEntries);
  // And the line says what every tool around it says about its own arguments.
  CHECK_EQ(entries["items"]["additionalProperties"].asBool(), false);

  // The promise, kept at both ends: each published extreme builds, and the two values the old
  // schema invited are refusals it now warns about first.
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, 20, 100, 500.0, 900).targetReps,
           std::optional<int>(100));
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, 1, 1, -500.0, 15).restSeconds,
           std::optional<int>(15));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, 5, 101, 82.5, 180); }));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, 5, 5, 82.5, 3600); }));
}

// The rule every tool publishes on its own arguments and CompositeToolHost enforces on every call,
// reaching one level down into the line: a key an entry never declared is REFUSED, never dropped.
// `targetRepsl: 5` used to read clean — the line stored no rep target at all, and the agent was
// told the routine had saved while the target it meant to set was gone.
TEST(gym_save_routine_names_a_misspelled_entry_key_rather_than_dropping_it) {
  Harness h;
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetRepsl"] = 5;
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Push A";
  args["position"] = 0;
  args["entries"] = Json::Value(Json::arrayValue);
  args["entries"].append(entry);

  const ToolResult refused = h.call("save_routine", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("save_routine: unknown routine entry field \"targetRepsl\". An entry takes: "
                       "exerciseId, targetSets, targetReps, targetWeightKg, restSeconds."));
  CHECK(h.repo.routineRows.empty());
}

// THE LOOP THIS TOOL PRINTS HAS TO WORK. save_routine's own description tells the caller to read the
// routine with list_routines, change what they mean, and send all of it back — and what
// list_routines hands over carries `position` on every line, plus `lastTrainedAt` on any routine
// trained under once. Both are the store's answers rather than anybody's input, and refusing them
// would make our own instruction a hard refusal on the surface gym is sold on. So they are declared,
// accepted and ignored; the run is renumbered from the order the entries arrive in either way.
//
// The misspelling above still has to die, which is the whole point: strictness that refuses a
// typo AND the document we ourselves emitted is not strictness, it is an outage.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_save_routine) {
  Harness h;
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetReps"] = 5;
  entry["targetWeightKg"] = 82.5;
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Push A";
  args["position"] = 0;
  args["entries"] = Json::Value(Json::arrayValue);
  args["entries"].append(entry);
  CHECK(!h.call("save_routine", args).isError);

  // Read it back exactly as an agent would, and change the one thing it came for.
  const ToolResult listed = h.call("list_routines", Json::Value(Json::objectValue));
  CHECK(!listed.isError);
  Json::Value document = body(listed)["routines"][0];
  CHECK_EQ(document["entries"][0]["position"].asInt(), 1);   // the key that used to be fatal
  document["entries"][0]["targetWeightKg"] = 85.0;

  const ToolResult saved = h.call("save_routine", document);

  CHECK(!saved.isError);
  CHECK_EQ(body(saved)["entries"][0]["targetWeightKg"].asDouble(), 85.0);
  CHECK_EQ(body(saved)["entries"][0]["position"].asInt(), 1);
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{1});
}

TEST(gym_save_routine_creates_a_fresh_id_and_replaces_one_that_exists) {
  Harness h;
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetReps"] = 5;
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Push A";
  args["position"] = 0;
  args["entries"] = Json::Value(Json::arrayValue);
  args["entries"].append(entry);

  const ToolResult created = h.call("save_routine", args);
  CHECK_FALSE(created.isError);
  CHECK_EQ(body(created)["name"].asString(), std::string("Push A"));

  Json::Value second(Json::objectValue);
  second["exerciseId"] = "back-squat";
  second["targetSets"] = 3;
  args["name"] = "Push A — heavy";
  args["entries"].append(second);
  const ToolResult replaced = h.call("save_routine", args);

  CHECK_FALSE(replaced.isError);
  CHECK_EQ(body(replaced)["name"].asString(), std::string("Push A — heavy"));
  REQUIRE_EQ(body(replaced)["entries"].size(), 2u);
  CHECK_EQ(body(replaced)["entries"][1]["exerciseId"].asString(), std::string("back-squat"));
  CHECK_EQ(body(replaced)["entries"][1]["position"].asInt(), 2);
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{1});   // replaced, never a second document
}

TEST(gym_save_routine_naming_no_movement_points_at_the_catalog) {
  Harness h;
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "zercher-squat";
  entry["targetSets"] = 5;
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Push A";
  args["position"] = 0;
  args["entries"] = Json::Value(Json::arrayValue);
  args["entries"].append(entry);

  const ToolResult refused = h.call("save_routine", args);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("save_routine: an entry names a movement no catalog holds. Call "
                       "list_exercises for the ids, or create_exercise to add one, then send the "
                       "whole routine again."));
}

TEST(gym_a_routine_read_narrows_to_one_and_wears_the_same_wrapper) {
  Harness h;
  h.repo.routineRows.push_back(pushA());

  const ToolResult all = h.call("list_routines", Json::Value(Json::objectValue));
  CHECK_EQ(body(all)["routines"].size(), 1u);

  const ToolResult one = h.call("list_routines", with("routineId", "rt_00000001"));
  REQUIRE_EQ(body(one)["routines"].size(), 1u);
  CHECK_EQ(body(one)["routines"][0]["id"].asString(), std::string("rt_00000001"));

  const ToolResult missing = h.call("list_routines", with("routineId", "rt_00000009"));
  CHECK(missing.isError);
  CHECK_EQ(message(missing),
           std::string("list_routines: no routine of yours has that id. Call this tool with no "
                       "routineId to list the ones you own."));
}

// ---- the coach share ---------------------------------------------------------------------------

TEST(gym_the_share_tool_answers_with_a_url_a_coach_can_open) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.finish("ses_00000001", 1'060'000);

  const ToolResult minted = h.call("share_session", with("sessionId", "ses_00000001"));

  CHECK_FALSE(minted.isError);
  const std::string token = body(minted)["token"].asString();
  CHECK_EQ(body(minted)["url"].asString(),
           std::string(kAppBase) + "/#/gym/shared/" + token);
  CHECK_EQ(body(minted)["expiresAt"].asUInt64(), shareExpiryAt(h.clock.now));
  // The link resolves, without a caller, to that one workout — which is what "anyone holding it" means.
  REQUIRE(h.service.shared(token).has_value());
  CHECK_EQ(h.service.shared(token)->startedAtMs, 1'000'000u);
}

TEST(gym_minting_a_share_twice_hands_back_the_same_live_link) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.finish("ses_00000001", 1'060'000);

  const ToolResult first = h.call("share_session", with("sessionId", "ses_00000001"));
  const ToolResult again = h.call("share_session", with("sessionId", "ses_00000001"));

  CHECK_EQ(body(again)["token"].asString(), body(first)["token"].asString());
  CHECK_EQ(h.repo.shares.size(), std::size_t{1});
}

TEST(gym_revoking_a_share_ends_the_link_and_a_second_revoke_says_there_is_nothing_to_end) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.finish("ses_00000001", 1'060'000);
  const std::string token =
      body(h.call("share_session", with("sessionId", "ses_00000001")))["token"].asString();

  const ToolResult revoked = h.call("revoke_share", with("sessionId", "ses_00000001"));
  CHECK_FALSE(revoked.isError);
  CHECK(body(revoked)["revoked"].asBool());
  CHECK_FALSE(h.service.shared(token).has_value());

  const ToolResult again = h.call("revoke_share", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("revoke_share: there is no live coach link on that workout, so there is "
                       "nothing to revoke — revoked, expired and never-minted are one answer here."));
}

// ---- the deletes --------------------------------------------------------------------------------

TEST(gym_a_running_workout_is_not_discarded_and_the_refusal_says_why) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);

  const ToolResult refused = h.call("discard_session", with("sessionId", "ses_00000001"));

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("discard_session: that workout is still running, and deleting one somebody "
                       "is logging into destroys the sets in flight. Close it with finish_session "
                       "first, then discard it."));
  CHECK_EQ(h.repo.sessions.size(), std::size_t{1});
  CHECK_EQ(h.repo.sets.size(), std::size_t{1});
}

TEST(gym_discarding_a_finished_workout_takes_its_sets_with_it) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.logSet("ses_00000001", "set_00000001", "back-squat", 100, 5, 1'060'000);
  h.finish("ses_00000001", 1'120'000);

  const ToolResult discarded = h.call("discard_session", with("sessionId", "ses_00000001"));

  CHECK_FALSE(discarded.isError);
  CHECK(body(discarded)["deleted"].asBool());
  CHECK_EQ(body(discarded)["sessionId"].asString(), std::string("ses_00000001"));
  CHECK_EQ(h.repo.sessions.size(), std::size_t{0});
  CHECK_EQ(h.repo.sets.size(), std::size_t{0});

  const ToolResult again = h.call("discard_session", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("discard_session: no workout of yours has that id. Call list_sessions for "
                       "the ids you own."));
}

TEST(gym_deleting_a_routine_leaves_the_workouts_trained_under_it_alone) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "ses_00000001";
  args["startedAt"] = Json::Value::UInt64(1'000'000);
  args["routineId"] = "rt_00000001";
  h.call("start_session", args);
  h.finish("ses_00000001", 1'060'000);

  const ToolResult deleted = h.call("delete_routine", with("routineId", "rt_00000001"));

  CHECK_FALSE(deleted.isError);
  CHECK(body(deleted)["deleted"].asBool());
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{0});
  // The frozen copy survives the plan it was taken from — the log still says what the workout was.
  const ToolResult session = h.call("get_session", with("sessionId", "ses_00000001"));
  CHECK_EQ(body(session)["session"]["plan"]["routine"].asString(), std::string("Push A"));

  const ToolResult again = h.call("delete_routine", with("routineId", "rt_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("delete_routine: no routine of yours has that id. Call list_routines for the "
                       "ids you own."));
}
