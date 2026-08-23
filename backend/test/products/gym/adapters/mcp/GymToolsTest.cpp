#include "products/gym/adapters/mcp/GymTools.h"

#include "platform/adapters/mcp/CompositeToolHost.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/application/PreferencesService.h"
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

// Deliberately NOT the api origin: a share becomes a page in the browser app.
const char* kAppBase = "https://windmill.works";

// One in-memory store, one hand-driven clock, the real service, the real tools.
struct Harness {
  FakeGym repo;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  TrainingService training{repo.log, repo.program, clock, tokens};
  CatalogService catalog{repo.catalog};
  ProgramService program{repo.program, clock};
  PreferencesService preferences{repo.preferences};
  GymTools tools{training, catalog, program, kAppBase};

  Harness() {
    repo.db.seed(benchPress());
    repo.db.seed(backSquat());
  }

  ToolResult call(const char* name, Json::Value args, const char* user = "u1") {
    // The grant is settled above these tools by CompositeToolHost, so the scope here is account-wide.
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

  ToolResult propose(const char* id, const char* routine, Json::Value entries,
                     const char* user = "u1") {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["routineId"] = routine;
    args["entries"] = std::move(entries);
    return call("propose_routine_change", args, user);
  }
};

// One line of a document as an agent sends it.
Json::Value entryOf(const char* exercise, int sets, int reps, double weightKg) {
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = exercise;
  entry["targetSets"] = sets;
  entry["targetReps"] = reps;
  entry["targetWeightKg"] = weightKg;
  return entry;
}

Json::Value oneEntry(const char* exercise, int sets, int reps, double weightKg) {
  Json::Value entries(Json::arrayValue);
  entries.append(entryOf(exercise, sets, reps, weightKg));
  return entries;
}

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
               "start_session gym:write", "log_set gym:write", "finish_session gym:write",
               "create_routine gym:write", "propose_routine_change gym:write",
               "create_exercise gym:write", "share_session gym:write",
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
  Harness h;

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
    CHECK(h.call(name, Json::Value(Json::objectValue)).isError);
}

// A retired name is answered by naming its replacement, never by "you were not granted gym:write".
TEST(gym_the_retired_routine_tools_name_what_replaced_them) {
  Harness h;

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
    CHECK(h.call(retirement.name.c_str(), Json::Value(Json::objectValue)).isError);
  }
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  const ToolResult saved = surface.callTool("save_routine", Json::Value(Json::objectValue),
                                            ToolCaller{uid(), ToolScope::everything()});
  CHECK(saved.isError);
  CHECK_EQ(message(saved), "save_routine: " + retired[0].sentence);
  CHECK(gymInstructions().find("save_routine") != std::string::npos);
  CHECK(gymInstructions().find("propose_routine_change") != std::string::npos);
}

// No agent may edit or delete a logged set at any level: the rule is about the verb, not the grant.
TEST(gym_publishes_no_tool_that_edits_or_deletes_a_logged_set) {
  Harness h;

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
    CHECK(h.call(name, Json::Value(Json::objectValue)).isError);
}

// A set the lifter deleted leaves its id free, and re-sending it under `gym:write` is refused: mint no fresh id.
TEST(gym_log_set_cannot_bring_back_a_set_the_lifter_deleted) {
  Harness h;
  h.start("ses_00000001", 1'700'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);
  h.training.deleteSet(UserId{"u1"}, SessionId{"ses_00000001"}, SetId{"set_00000001"});

  ToolResult replayed =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);

  CHECK(replayed.isError);
  CHECK_EQ(message(replayed),
           std::string("log_set: that set was deleted from the log. It is not coming back, and a "
                       "fresh id would only log it again — leave it out."));
  CHECK_EQ(h.repo.db.sets, std::vector<Set>{});
}

TEST(gym_tools_list_carries_exactly_the_levels_a_grant_named) {
  Harness h;

  const std::vector<std::string> reads{"list_exercises", "list_sessions", "get_session",
                                       "last_time",      "list_routines", "get_stats"};
  const std::vector<std::string> writes{"start_session",  "log_set",
                                        "finish_session", "create_routine",
                                        "propose_routine_change", "create_exercise",
                                        "share_session"};
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
  Harness h;

  CHECK_EQ(namesIn(h.tools.listTools(ToolCaller{uid(), parseToolScope("roadmap:read roadmap:write")})),
           (std::vector<std::string>{}));
}

// A duplicate tool name is a construction failure, so a collision takes the server down at start-up.
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
  CHECK_EQ(h.repo.db.sets.size(), std::size_t{0});
}

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
  CHECK_EQ(h.repo.db.sets.size(), std::size_t{1});
}

TEST(gym_a_replayed_start_answers_with_the_workout_already_open) {
  Harness h;
  const ToolResult first = h.start("ses_00000001", h.clock.now);

  const ToolResult replay = h.start("ses_00000001", h.clock.now);

  CHECK_FALSE(replay.isError);
  CHECK_EQ(body(replay), body(first));
  CHECK_EQ(h.repo.db.sessions.size(), std::size_t{1});
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

// A start in the future is refused before it is stored, naming the gap and the instant to send.
TEST(gym_a_start_in_the_logs_future_is_refused_and_names_the_gap) {
  Harness h;

  const ToolResult refused = h.start("ses_00000001", h.clock.now + 24ull * 60 * 60 * 1000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: that startedAt is 1440 minutes ahead of the log's clock, and "
                       "a workout cannot start in the future — the log would be locked behind it "
                       "until it aged out. Send the instant the workout actually began (now, for "
                       "one starting now), in epoch milliseconds."));
  CHECK(h.repo.db.sessions.empty());
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
  CHECK_EQ(h.repo.db.sessions.size(), std::size_t{0});
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

// The domain's own sentence, forwarded verbatim rather than flattened into "could not read that set".
TEST(gym_a_value_the_domain_refuses_reaches_the_agent_as_the_domains_own_sentence) {
  Harness h;
  h.start("ses_00000001", h.clock.now);

  const ToolResult refused =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 80, 0, h.clock.now + 60'000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("log_set: reps out of range"));
  CHECK_EQ(h.repo.db.sets.size(), std::size_t{0});
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

// The first close is permanent: a finish sent twice answers with the end the workout already has.
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

// A schema is a promise about what the write will accept, so every bound in it is the DOMAIN's.
TEST(gym_the_routine_entry_schema_publishes_the_bounds_the_domain_actually_keeps) {
  Json::Value entries(Json::nullValue);
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "propose_routine_change")
      entries = tool.descriptor["inputSchema"]["properties"]["entries"];
  REQUIRE(entries.isObject());
  const Json::Value& fields = entries["items"]["properties"];

  CHECK_EQ(fields["targetSets"]["minimum"].asInt(), 1);
  CHECK_EQ(fields["targetSets"]["maximum"].asInt(), 20);
  CHECK_EQ(fields["targetReps"]["minimum"].asInt(), 1);
  CHECK_EQ(fields["targetReps"]["maximum"].asInt(), 100);
  CHECK_EQ(fields["restSeconds"]["minimum"].asInt(), 15);
  CHECK_EQ(fields["restSeconds"]["maximum"].asInt(), 900);
  // The document's own size is published beside its fields' values.
  CHECK_EQ(entries["minItems"].asInt(), 1);
  CHECK_EQ(entries["maxItems"].asInt(), kMaxRoutineEntries);
  CHECK_EQ(entries["items"]["additionalProperties"].asBool(), false);

  // The promise, kept at both ends: each published extreme builds.
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, 20, 100, 500.0, 900).targetReps,
           std::optional<int>(100));
  CHECK_EQ(RoutineEntry(1, ExerciseId{"bench-press"}, 1, 1, -500.0, 15).restSeconds,
           std::optional<int>(15));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, 5, 101, 82.5, 180); }));
  CHECK(refuses([] { RoutineEntry(1, ExerciseId{"bench-press"}, 5, 5, 82.5, 3600); }));
}

// A key an entry never declared is refused, never dropped.
TEST(gym_a_proposal_names_a_misspelled_entry_key_rather_than_dropping_it) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = "bench-press";
  entry["targetSets"] = 5;
  entry["targetRepsl"] = 5;
  Json::Value entries(Json::arrayValue);
  entries.append(entry);

  const ToolResult refused = h.propose("prop_00000001", "rt_00000001", entries);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("propose_routine_change: unknown routine entry field \"targetRepsl\". An "
                       "entry takes: exerciseId, targetSets, targetReps, targetWeightKg, "
                       "restSeconds."));
  CHECK(h.repo.db.proposalRows.empty());
}

// `position` is the store's own answer on a line list_routines hands over, so it is declared, accepted and ignored.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_propose_routine_change) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());

  // Read it back exactly as an agent would, and change the one thing it came for.
  const ToolResult listed = h.call("list_routines", Json::Value(Json::objectValue));
  REQUIRE(!listed.isError);
  Json::Value document = body(listed)["routines"][0];
  CHECK_EQ(document["entries"][0]["position"].asInt(), 1);
  document["entries"][0]["targetWeightKg"] = 85.0;

  const ToolResult minted = h.propose("prop_00000001", "rt_00000001", document["entries"]);

  REQUIRE(!minted.isError);
  const Json::Value& proposal = body(minted)["proposal"];
  REQUIRE_EQ(proposal["changes"].size(), 1u);
  CHECK_EQ(proposal["changes"][0]["kind"].asString(), std::string("retargeted"));
  CHECK_EQ(proposal["changes"][0]["before"]["weightKg"].asDouble(), 82.5);
  CHECK_EQ(proposal["changes"][0]["after"]["weightKg"].asDouble(), 85.0);
  CHECK_EQ(h.repo.db.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

// Nothing an agent can call changes an existing routine: the stored rows are compared whole, before and after.
TEST(gym_proposing_a_change_writes_nothing_to_the_program) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  const std::vector<Routine> before = h.repo.db.routineRows;

  const ToolResult minted =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.db.routineRows, before);
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
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));
  h.clock.now += 60'000;

  const ToolResult second =
      h.propose("prop_00000002", "rt_00000001", oneEntry("bench-press", 5, 3, 90.0));

  REQUIRE(!second.isError);
  const std::vector<ProposalHead> heads =
      h.program.proposals(uid(), ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{2});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[1].state, ProposalState::superseded);
  CHECK_EQ(heads[1].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  // And only one of them is what a card draws.
  CHECK_EQ(h.program.proposals(uid(), ProposalQuery{std::nullopt, true}).size(), std::size_t{1});
}

// The transport resolves a connection — id and registered name — and the tool stores both on the proposal.
TEST(gym_a_proposal_minted_over_a_connection_carries_that_connections_id_and_name) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", 5, 3, 87.5);
  const ToolCaller claude{uid(), ToolScope::everything(), ToolConnection{"cli_x", "Claude Desktop"}};

  const ToolResult minted = h.tools.callTool("propose_routine_change", args, claude);

  REQUIRE(!minted.isError);
  REQUIRE_EQ(h.repo.db.proposalRows.size(), std::size_t{1});
  CHECK((h.repo.db.proposalRows[0].head.source ==
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
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  const ToolCaller claude{uid(), ToolScope::everything(), ToolConnection{"cli_x", "Claude Desktop"}};
  const ToolCaller cursor{uid(), ToolScope::everything(), ToolConnection{"key_y", "Cursor"}};
  auto proposeAs = [&](const char* id, double kg, const ToolCaller& who) {
    Json::Value args(Json::objectValue);
    args["id"] = id;
    args["routineId"] = "rt_00000001";
    args["entries"] = oneEntry("bench-press", 5, 3, kg);
    return h.tools.callTool("propose_routine_change", args, who);
  };

  REQUIRE(!proposeAs("prop_00000001", 87.5, claude).isError);
  h.clock.now += 60'000;
  REQUIRE(!proposeAs("prop_00000002", 90.0, cursor).isError);
  h.clock.now += 60'000;
  REQUIRE(!proposeAs("prop_00000003", 92.5, claude).isError);

  const std::vector<ProposalHead> heads =
      h.program.proposals(uid(), ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{3});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000003"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[1].state, ProposalState::pending);
  CHECK_EQ(heads[2].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[2].state, ProposalState::superseded);
  CHECK_EQ(heads[2].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(h.program.proposals(uid(), ProposalQuery{std::nullopt, true}).size(), std::size_t{2});
}

// A replay reads back the proposal it already minted: the id is the idempotency key here as everywhere.
TEST(gym_a_replayed_proposal_reads_back_the_one_already_waiting) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  const ToolResult replayed =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  REQUIRE(!replayed.isError);
  CHECK_EQ(body(replayed)["proposal"]["state"].asString(), std::string("pending"));
  CHECK_EQ(h.repo.db.proposalRows.size(), std::size_t{1});
}

// A replay is decided on the DOCUMENT and never on the id alone: a different diff under a spent id is refused.
TEST(gym_a_proposal_id_resent_with_a_different_document_is_refused_rather_than_answered_ok) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  const ToolResult second =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 3, 12, 50.0));

  CHECK(second.isError);
  CHECK(message(second).find("DIFFERENT proposal") != std::string::npos);
  CHECK(message(second).find("NOTHING WAS MINTED") != std::string::npos);
  REQUIRE_EQ(h.repo.db.proposalRows.size(), std::size_t{1});
  CHECK_EQ(h.repo.db.proposalRows[0].head.state, ProposalState::pending);
  CHECK_EQ(h.repo.db.proposalRows[0].changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, std::nullopt}));
}

// Every field list_routines puts on a routine survives a read-and-send-back.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_create_routine) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.db.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  Json::Value document = body(h.call("list_routines", Json::Value(Json::objectValue)))["routines"][0];
  REQUIRE_EQ(document["revision"].asInt(), 1);
  REQUIRE(document.isMember("pendingProposal"));
  document["id"] = "rt_00000002";
  document["name"] = "Push B";

  const ToolResult duplicated =
      surface.callTool("create_routine", document, ToolCaller{uid(), ToolScope::everything()});

  REQUIRE(!duplicated.isError);
  CHECK_EQ(body(duplicated)["name"].asString(), std::string("Push B"));
  CHECK_EQ(body(duplicated)["revision"].asInt(), 1);
  CHECK(body(duplicated)["pendingProposal"].isNull());
  CHECK_EQ(h.repo.db.routineRows.size(), std::size_t{2});
}

// The dot on the read an agent already makes, which is why there is no `list_proposals` here.
TEST(gym_list_routines_carries_the_proposal_waiting_on_a_day_of_the_program) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());

  const Json::Value quiet = body(h.call("list_routines", Json::Value(Json::objectValue)));
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));
  const Json::Value waiting = body(h.call("list_routines", Json::Value(Json::objectValue)));

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
  Harness h;
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Push A";
  args["position"] = 0;
  args["entries"] = oneEntry("bench-press", 5, 5, 82.5);

  const ToolResult created = h.call("create_routine", args);
  REQUIRE(!created.isError);
  CHECK_EQ(body(created)["name"].asString(), std::string("Push A"));
  CHECK_EQ(body(created)["revision"].asInt(), 1);
  CHECK_EQ(h.repo.db.routineRows.size(), std::size_t{1});

  // A lost reply is resent verbatim, and this product answers a replay everywhere else.
  const ToolResult replayed = h.call("create_routine", args);
  CHECK_FALSE(replayed.isError);
  CHECK_EQ(body(replayed)["revision"].asInt(), 1);
  CHECK_EQ(h.repo.db.routineRows.size(), std::size_t{1});

  args["name"] = "Push A — heavy";
  const ToolResult again = h.call("create_routine", args);

  CHECK(again.isError);
  CHECK(message(again).find("propose_routine_change") != std::string::npos);
  CHECK_EQ(h.repo.db.routineRows[0].name, std::string("Push A"));   // the edit did not land
}

// A line with no `targetSets` is OPEN and the rack decides; the created day names the door it came through.
TEST(gym_create_routine_takes_an_open_line_and_the_history_names_the_door) {
  Harness h;
  h.repo.db.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
                       2.5, false});
  Json::Value open(Json::objectValue);
  open["exerciseId"] = "barbell-row";
  Json::Value args(Json::objectValue);
  args["id"] = "rt_00000001";
  args["name"] = "Heavy Thursday";
  args["position"] = 0;
  args["entries"] = Json::Value(Json::arrayValue);
  args["entries"].append(open);

  const ToolResult created = h.call("create_routine", args);

  REQUIRE(!created.isError);
  CHECK(body(created)["entries"][0]["targetSets"].isNull());   // omitted: the line asks at the rack
  const std::vector<RoutineEvent> history =
      h.program.routineHistory(uid(), RoutineId{"rt_00000001"});
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

// Refused at the mint, not at the tap.
TEST(gym_a_proposal_naming_no_movement_is_refused_before_it_is_ever_minted) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());

  const ToolResult refused =
      h.propose("prop_00000001", "rt_00000001", oneEntry("zercher-squat", 5, 5, 82.5));

  CHECK(refused.isError);
  CHECK(message(refused).find("was not minted") != std::string::npos);
  CHECK(h.repo.db.proposalRows.empty());
}

TEST(gym_proposing_a_change_to_a_routine_that_is_not_yours_points_at_the_two_doors) {
  Harness h;

  const ToolResult refused =
      h.propose("prop_00000001", "rt_00000009", oneEntry("bench-press", 5, 5, 82.5));

  CHECK(refused.isError);
  CHECK(message(refused).find("list_routines") != std::string::npos);
  CHECK(message(refused).find("create_routine") != std::string::npos);
}

TEST(gym_a_routine_read_narrows_to_one_and_wears_the_same_wrapper) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());

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
  // The link resolves, without a caller, to that one workout.
  REQUIRE(h.training.shared(token).has_value());
  CHECK_EQ(h.training.shared(token)->startedAtMs, 1'000'000u);
}

TEST(gym_minting_a_share_twice_hands_back_the_same_live_link) {
  Harness h;
  h.start("ses_00000001", 1'000'000);
  h.finish("ses_00000001", 1'060'000);

  const ToolResult first = h.call("share_session", with("sessionId", "ses_00000001"));
  const ToolResult again = h.call("share_session", with("sessionId", "ses_00000001"));

  CHECK_EQ(body(again)["token"].asString(), body(first)["token"].asString());
  CHECK_EQ(h.repo.db.shares.size(), std::size_t{1});
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
  CHECK_FALSE(h.training.shared(token).has_value());

  const ToolResult again = h.call("revoke_share", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("revoke_share: there is no live coach link on that workout, so there is "
                       "nothing to revoke — revoked, expired and never-minted are one answer here."));
}

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
  CHECK_EQ(h.repo.db.sessions.size(), std::size_t{1});
  CHECK_EQ(h.repo.db.sets.size(), std::size_t{1});
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
  CHECK_EQ(h.repo.db.sessions.size(), std::size_t{0});
  CHECK_EQ(h.repo.db.sets.size(), std::size_t{0});

  const ToolResult again = h.call("discard_session", with("sessionId", "ses_00000001"));
  CHECK(again.isError);
  CHECK_EQ(message(again),
           std::string("discard_session: no workout of yours has that id. Call list_sessions for "
                       "the ids you own."));
}

// `gym:delete` buys the right to PROPOSE a destructive change and nothing else.
TEST(gym_proposing_a_removal_deletes_nothing_and_draws_what_would_go) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  const std::vector<Routine> before = h.repo.db.routineRows;
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["summary"] = "You have not trained this in three months.";

  const ToolResult minted = h.call("propose_routine_removal", args);

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.db.routineRows, before);
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
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  h.start("ses_00000001", 1'700'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'060'000);
  h.logSet("ses_00000001", "set_00000002", "bench-press", 82.5, 5, 1'700'000'120'000);
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";

  const ToolResult minted = h.call("propose_routine_removal", args);

  REQUIRE(!minted.isError);
  CHECK_EQ(body(minted)["proposal"]["changes"][0]["loggedSets"].asInt(), 2);
}

// No agent may read or write a lifter's settings at any level: the rule is about the verb, not the grant.
TEST(gym_publishes_no_tool_that_reads_or_writes_a_lifters_settings) {
  Harness h;

  const std::vector<std::string> everything =
      namesIn(h.tools.listTools(ToolCaller{uid(), ToolScope::everything()}));

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
    CHECK(h.call(name, Json::Value(Json::objectValue)).isError);
  CHECK_EQ(h.repo.db.preferenceRows.size(), std::size_t{0});
}

// The one retirement in this catalog with no replacement to name, so the sentence says that out loud.
TEST(gym_retired_get_preferences_says_that_nothing_replaced_it) {
  Harness h;
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

// The same sentence reaches a client at connect, pinned here beside retiredTools()'s copy.
TEST(gym_connect_paragraph_carries_the_retirement) {
  const std::string paragraph = gymInstructions();

  CHECK(paragraph.find("`get_preferences` does not exist and nothing replaced it") !=
        std::string::npos);
  CHECK(paragraph.find("keeps no plate inventory") != std::string::npos);
}

// The rest dial is inherited at the rack and this server fills in nothing, with the lifter's dial armed.
TEST(gym_an_armed_rest_dial_is_never_copied_into_a_routine_line_that_names_none) {
  Harness h;
  h.preferences.savePreferences(GymPreferences{uid(), Unit::kg, 120, true, true, false});

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
  CHECK(!h.call("create_routine", args).isError);

  const ToolResult listed = h.call("list_routines", Json::Value(Json::objectValue));

  CHECK_FALSE(listed.isError);
  CHECK(body(listed)["routines"][0]["entries"][0]["restSeconds"].isNull());
  CHECK_EQ(h.preferences.preferences(uid()).restSeconds, std::optional<int>(120));
}

// `gym:read` cannot mint a proposal, and the gate is the composite's rather than gym's, so it is called through it.
TEST(gym_read_alone_cannot_mint_a_proposal) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.db.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", 5, 3, 87.5);

  const ToolResult refused =
      surface.callTool("propose_routine_change", args, ToolCaller{uid(), parseToolScope("gym:read")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:write") != std::string::npos);
  CHECK(h.repo.db.proposalRows.empty());
  // And a grant that names the level mints, through the very same door.
  CHECK_FALSE(surface
                  .callTool("propose_routine_change", args,
                            ToolCaller{uid(), parseToolScope("gym:read gym:write")})
                  .isError);
  CHECK_EQ(h.repo.db.proposalRows.size(), std::size_t{1});
  CHECK_EQ(h.repo.db.routineRows[0].revision, 1);
  CHECK_EQ(h.repo.db.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

// A removal is `gym:delete`'s: the three levels are a grant vocabulary and none implies another.
TEST(gym_write_alone_cannot_propose_a_removal) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.db.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";

  const ToolResult refused = surface.callTool("propose_routine_removal", args,
                                              ToolCaller{uid(), parseToolScope("gym:write")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:delete") != std::string::npos);
  CHECK(h.repo.db.proposalRows.empty());
}

// A document identical to what the routine already says proposes nothing.
TEST(gym_a_proposal_that_changes_nothing_is_refused_rather_than_shown_to_a_lifter) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());
  const Json::Value document = body(h.call("list_routines", Json::Value(Json::objectValue)))
                                   ["routines"][0]["entries"];

  const ToolResult refused = h.propose("prop_00000001", "rt_00000001", document);

  CHECK(refused.isError);
  CHECK(message(refused).find("already says") != std::string::npos);
  CHECK(h.repo.db.proposalRows.empty());
}

// The read receipt rides in the tool's own reply: the server counts the rows it served.

TEST(gym_a_workout_read_answers_with_the_rows_it_served) {
  Harness h;
  h.start("ses_00000001", 1'700'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'300'000);
  h.logSet("ses_00000001", "set_00000002", "bench-press", 82.5, 5, 1'700'000'600'000);
  h.finish("ses_00000001", 1'700'000'900'000);

  Json::Value args(Json::objectValue);
  args["sessionId"] = "ses_00000001";
  const Json::Value read = body(h.call("get_session", args))["read"];

  CHECK_EQ(read["sets"].asInt(), 2);
  CHECK_EQ(read["sessions"].asInt(), 1);
  CHECK_EQ(read["weeks"].asInt(), 1);
}

// A page NAMES workouts and counts their sets; it hands over no set rows, so it claims none.
TEST(gym_a_log_page_claims_the_workouts_it_named_and_not_their_sets) {
  Harness h;
  h.start("ses_00000001", 1'700'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 5, 1'700'000'300'000);
  h.finish("ses_00000001", 1'700'000'900'000);
  h.clock.now = 1'700'600'000'000;
  h.start("ses_00000002", 1'700'600'000'000);
  h.logSet("ses_00000002", "set_00000002", "back-squat", 100, 5, 1'700'600'300'000);
  h.finish("ses_00000002", 1'700'600'900'000);

  const Json::Value read = body(h.call("list_sessions", Json::Value(Json::objectValue)))["read"];

  CHECK_EQ(read["sets"].asInt(), 0);
  CHECK_EQ(read["sessions"].asInt(), 2);
  CHECK_EQ(read["weeks"].asInt(), 2);  // a Tuesday and the Tuesday after: two Monday-to-Monday weeks
}

// The catalog and the program are not the log, so they make no claim at all.
TEST(gym_a_read_that_served_no_log_rows_says_nothing_about_what_it_read) {
  Harness h;
  CHECK_FALSE(body(h.call("list_exercises", Json::Value(Json::objectValue))).isMember("read"));
  CHECK_FALSE(body(h.call("list_routines", Json::Value(Json::objectValue))).isMember("read"));
}

// Provenance is a column and not a fork: the same tool through the MCP door mints a proposal that says so.
TEST(gym_a_proposal_minted_over_mcp_carries_the_mcp_door) {
  Harness h;
  h.repo.db.routineRows.push_back(pushA());

  const ToolResult minted =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  CHECK_FALSE(minted.isError);
  CHECK_EQ(body(minted)["proposal"]["source"]["door"].asString(), std::string("mcp"));
}
