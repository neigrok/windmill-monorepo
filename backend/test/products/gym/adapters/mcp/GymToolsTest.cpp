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
               "create_routine gym:write", "propose_routine_change gym:write",
               "create_exercise gym:write", "share_session gym:write",
               "discard_session gym:delete", "propose_routine_removal gym:delete",
               "revoke_share gym:delete"}));
}

// W6'S WHOLE CONTRACT, said as a table so it cannot be read two ways. `create_routine` LANDS — a day
// of the program that did not exist takes nothing away — and the two `propose_` tools land nothing
// at all. The names carry it, because agent authors read names and not our architecture doc: the
// unforgivable outcome of this wave would be a well-behaved agent telling its human that a routine
// changed when it did not.
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

// APPLY IS NOT A CAPABILITY. There is no tool for it at any level — not under `gym:write`, not under
// `gym:delete`, not under the account-wide grant — and the dispatcher answers no such call under
// every name a model might reach for. The two set writes above live under the same rule; this is the
// third verb reserved for the hand.
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

// THE RETIREMENT ANSWER. An agent written against the old catalog calls one of these on its first
// turn after this deploy, and what it reads is a connected user's whole first experience of the
// wave. It names the replacement — never "you were not granted gym:write", which would be FALSE:
// the level was granted, the tool was retired. The sentences live in retiredTools(), which is what
// the composite over MCP and Ask in-process answer from once a name misses the live catalog.
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
  // Through the composite — the door an MCP client actually uses — the sentence is the answer.
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  const ToolResult saved = surface.callTool("save_routine", Json::Value(Json::objectValue),
                                            ToolCaller{uid(), ToolScope::everything()});
  CHECK(saved.isError);
  CHECK_EQ(message(saved), "save_routine: " + retired[0].sentence);
  // And the handshake every client reads at connect carries the same retirement, so an agent
  // written against the old two learns it before its first call.
  CHECK(gymInstructions().find("save_routine") != std::string::npos);
  CHECK(gymInstructions().find("propose_routine_change") != std::string::npos);
}

// NO AGENT MAY EDIT OR DELETE A LOGGED SET. The table above pins it by being exhaustive, but only
// implicitly — so this case says the rule out loud, because the failure it guards against is a
// future wave "completing the catalog" beside two REST routes that exist. The tool layer is the only
// place gym can tell an agent from a hand, and the coach's own refusal is built on this being true:
// *"That one is yours to change. I can read what you lifted; I can't edit it."* Every level is
// searched, because the rule is about the verb and not about which grant reaches it.
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
  // And the dispatcher answers no such call under any of those names either, whatever a client
  // sends: an unroutable name is a refusal here, never a silent write.
  for (const char* name : {"fix_set", "edit_set", "update_set", "delete_set"})
    CHECK(h.call(name, Json::Value(Json::objectValue)).isError);
}

// The rule above has one door left, and it is not a name: `log_set` is a WRITE an agent holds, and a
// set the lifter deleted by hand leaves its id free of the primary key that used to answer a replay.
// Re-sending that id under `gym:write` would put the set back — a deletion no agent may make, undone
// by an agent all the same. It is refused, and the refusal says the opposite thing to the spent-id
// one beside it: mint no fresh id, because a fresh id logs the deleted set again.
TEST(gym_log_set_cannot_bring_back_a_set_the_lifter_deleted) {
  Harness h;
  h.start("ses_00000001", 1'700'000'000'000);
  h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);
  h.service.deleteSet(UserId{"u1"}, SessionId{"ses_00000001"}, SetId{"set_00000001"});

  ToolResult replayed =
      h.logSet("ses_00000001", "set_00000001", "bench-press", 82.5, 8, 1'700'000'060'000);

  CHECK(replayed.isError);
  CHECK_EQ(message(replayed),
           std::string("log_set: that set was deleted from the log. It is not coming back, and a "
                       "fresh id would only log it again — leave it out."));
  CHECK_EQ(h.repo.sets, std::vector<Set>{});
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

// A model that says "tomorrow" would otherwise brick the log: the phantom never ages out and every
// later start joins it. Refused before it is stored, naming the gap and the instant to send.
TEST(gym_a_start_in_the_logs_future_is_refused_and_names_the_gap) {
  Harness h;

  const ToolResult refused = h.start("ses_00000001", h.clock.now + 24ull * 60 * 60 * 1000);

  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("start_session: that startedAt is 1440 minutes ahead of the log's clock, and "
                       "a workout cannot start in the future — the log would be locked behind it "
                       "until it aged out. Send the instant the workout actually began (now, for "
                       "one starting now), in epoch milliseconds."));
  CHECK(h.repo.sessions.empty());
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
TEST(gym_a_proposal_names_a_misspelled_entry_key_rather_than_dropping_it) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
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
  CHECK(h.repo.proposalRows.empty());
}

// THE LOOP THESE TOOLS PRINT HAS TO WORK. propose_routine_change's own description tells the caller
// to read the routine with list_routines, change what they mean, and send all of it back — and what
// list_routines hands over carries `position` on every line. It is the store's answer rather than
// anybody's input, and refusing it would make our own printed instruction a hard refusal on the
// surface gym is sold on. So it is declared, accepted and ignored; the run is renumbered from the
// order the entries arrive in either way.
//
// The misspelling above still has to die, which is the whole point: strictness that refuses a typo
// AND the document we ourselves emitted is not strictness, it is an outage.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_propose_routine_change) {
  Harness h;
  h.repo.routineRows.push_back(pushA());

  // Read it back exactly as an agent would, and change the one thing it came for.
  const ToolResult listed = h.call("list_routines", Json::Value(Json::objectValue));
  REQUIRE(!listed.isError);
  Json::Value document = body(listed)["routines"][0];
  CHECK_EQ(document["entries"][0]["position"].asInt(), 1);   // the key that used to be fatal
  document["entries"][0]["targetWeightKg"] = 85.0;

  const ToolResult minted = h.propose("prop_00000001", "rt_00000001", document["entries"]);

  REQUIRE(!minted.isError);
  const Json::Value& proposal = body(minted)["proposal"];
  REQUIRE_EQ(proposal["changes"].size(), 1u);
  CHECK_EQ(proposal["changes"][0]["kind"].asString(), std::string("retargeted"));
  CHECK_EQ(proposal["changes"][0]["before"]["weightKg"].asDouble(), 82.5);
  CHECK_EQ(proposal["changes"][0]["after"]["weightKg"].asDouble(), 85.0);
  // And the routine is exactly where it was: this tool writes nothing.
  CHECK_EQ(h.repo.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

// THE CLAIM THIS WHOLE WAVE MAKES, proved by executing it rather than by reading the code: nothing an
// agent can call changes an existing routine. The stored rows are compared whole, before and after,
// so a field that moved anywhere in the document fails this case.
TEST(gym_proposing_a_change_writes_nothing_to_the_program) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  const std::vector<Routine> before = h.repo.routineRows;

  const ToolResult minted =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.routineRows, before);
  // The receipt is not shaped like a write: there is no routine in it at all, the state says so, and
  // the note tells the agent what to say to its human.
  CHECK(body(minted)["routine"].isNull());
  CHECK_EQ(body(minted)["proposal"]["state"].asString(), std::string("pending"));
  CHECK_EQ(body(minted)["proposal"]["changeCount"].asInt(), 1);
  CHECK_EQ(body(minted)["reviewUrl"].asString(),
           std::string("https://windmill.works/#/gym/proposals/prop_00000001"));
  CHECK(body(minted)["note"].asString().find("Nothing has changed") != std::string::npos);
  CHECK(body(minted)["note"].asString().find("no tool on this connection can apply it") !=
        std::string::npos);
}

// One pending proposal per routine per door: a second one supersedes the first, and the first drops
// into the routine's dated history rather than vanishing. Nothing piles up, nothing disappears.
TEST(gym_a_second_proposal_supersedes_the_first_and_the_first_stays_in_the_history) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));
  h.clock.now += 60'000;

  const ToolResult second =
      h.propose("prop_00000002", "rt_00000001", oneEntry("bench-press", 5, 3, 90.0));

  REQUIRE(!second.isError);
  const std::vector<ProposalHead> heads =
      h.service.proposals(uid(), ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{2});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[1].state, ProposalState::superseded);
  CHECK_EQ(heads[1].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  // And only one of them is what a card draws.
  CHECK_EQ(h.service.proposals(uid(), ProposalQuery{std::nullopt, true}).size(), std::size_t{1});
}

// THE PROPOSAL NAMES THE AGENT THAT MADE IT. The transport resolves a connection — an OAuth client
// or an MCP key, its id and its registered name — and the tool stores both on the proposal, so the
// card a lifter reads says "Claude Desktop" where it used to draw a fallback for an agent nobody
// could name.
TEST(gym_a_proposal_minted_over_a_connection_carries_that_connections_id_and_name) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", 5, 3, 87.5);
  const ToolCaller claude{uid(), ToolScope::everything(), ToolConnection{"cli_x", "Claude Desktop"}};

  const ToolResult minted = h.tools.callTool("propose_routine_change", args, claude);

  REQUIRE(!minted.isError);
  REQUIRE_EQ(h.repo.proposalRows.size(), std::size_t{1});
  CHECK((h.repo.proposalRows[0].head.source ==
         ProposalSource{ProposalDoor::mcp, "cli_x", "Claude Desktop", std::nullopt}));
  // And the wire carries both, exactly where every client already reads them.
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

// One pending proposal per (routine, door, CONNECTION): two agents on one account each hold their
// own, and the second does not take the first off the lifter's screen — while the same agent
// proposing twice still replaces its own. Before the connection travelled, every MCP proposal
// stored an empty one and two agents superseded each other.
TEST(gym_two_connections_each_hold_a_pending_proposal_on_one_routine_and_one_connection_holds_one) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
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
      h.service.proposals(uid(), ProposalQuery{std::nullopt, false});
  REQUIRE_EQ(heads.size(), std::size_t{3});
  CHECK_EQ(heads[0].id, ProposalId{"prop_00000003"});
  CHECK_EQ(heads[0].state, ProposalState::pending);
  CHECK_EQ(heads[1].id, ProposalId{"prop_00000002"});
  CHECK_EQ(heads[1].state, ProposalState::pending);
  CHECK_EQ(heads[2].id, ProposalId{"prop_00000001"});
  CHECK_EQ(heads[2].state, ProposalState::superseded);
  CHECK_EQ(heads[2].settledAtMs, std::optional<std::uint64_t>(h.clock.now));
  CHECK_EQ(h.service.proposals(uid(), ProposalQuery{std::nullopt, true}).size(), std::size_t{2});
}

// A replay reads back the proposal it already minted. Without it an agent that lost a reply would
// mint a second id, supersede its own first, and leave a spurious superseded row in a lifter's
// history — which is why the id is the idempotency key here exactly as it is everywhere else.
TEST(gym_a_replayed_proposal_reads_back_the_one_already_waiting) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  const ToolResult replayed =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  REQUIRE(!replayed.isError);
  CHECK_EQ(body(replayed)["proposal"]["state"].asString(), std::string("pending"));
  CHECK_EQ(h.repo.proposalRows.size(), std::size_t{1});
}

// THE UNFORGIVABLE DEFECT RUNNING BACKWARDS, and the reason a replay is decided on the DOCUMENT and
// never on the id alone. A second, genuinely different diff sent under an id that is already spent
// used to be answered `[ok]` with the note *"this proposal is waiting in the lifter's app"* — while
// the document just sent was thrown away and what waited was the FIRST idea. An agent that had just
// told its human it proposed a deload was made a liar by our receipt. It is refused instead, in the
// same words create_routine refuses the same shape, and nothing of the caller's is spent.
TEST(gym_a_proposal_id_resent_with_a_different_document_is_refused_rather_than_answered_ok) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  const ToolResult second =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 3, 12, 50.0));

  CHECK(second.isError);
  CHECK(message(second).find("DIFFERENT proposal") != std::string::npos);
  CHECK(message(second).find("NOTHING WAS MINTED") != std::string::npos);
  // The first idea is still the one waiting, untouched and still pending.
  REQUIRE_EQ(h.repo.proposalRows.size(), std::size_t{1});
  CHECK_EQ(h.repo.proposalRows[0].head.state, ProposalState::pending);
  CHECK_EQ(h.repo.proposalRows[0].changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, std::nullopt}));
}

// THE OTHER LOOP THESE TOOLS PRINT. create_routine's own description says a new day is minted under
// a fresh id, and the way an agent duplicates a Tuesday is by reading one and sending it back — so
// every field list_routines PUTS ON a routine has to survive the trip. `revision` and
// `pendingProposal` are this wave's two, and they arrive on a routine an agent reads today. Proved
// through the COMPOSITE, because `additionalProperties: false` is enforced there and nowhere else.
TEST(gym_a_routine_read_with_list_routines_goes_straight_back_through_create_routine) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.routineRows.push_back(pushA());
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  Json::Value document = body(h.call("list_routines", Json::Value(Json::objectValue)))["routines"][0];
  REQUIRE_EQ(document["revision"].asInt(), 1);            // the two keys that used to be fatal
  REQUIRE(document.isMember("pendingProposal"));
  document["id"] = "rt_00000002";                        // the duplicate is a NEW day, on a new id
  document["name"] = "Push B";

  const ToolResult duplicated =
      surface.callTool("create_routine", document, ToolCaller{uid(), ToolScope::everything()});

  REQUIRE(!duplicated.isError);
  CHECK_EQ(body(duplicated)["name"].asString(), std::string("Push B"));
  CHECK_EQ(body(duplicated)["revision"].asInt(), 1);
  // The new day carries no proposal: a card belongs to the routine it was minted against.
  CHECK(body(duplicated)["pendingProposal"].isNull());
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{2});
}

// The dot §B5 draws, on the read an agent already makes — which is why there is no `list_proposals`
// and no `get_proposal` in this catalog: a proposal always targets a routine.
TEST(gym_list_routines_carries_the_proposal_waiting_on_a_day_of_the_program) {
  Harness h;
  h.repo.routineRows.push_back(pushA());

  const Json::Value quiet = body(h.call("list_routines", Json::Value(Json::objectValue)));
  h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));
  const Json::Value waiting = body(h.call("list_routines", Json::Value(Json::objectValue)));

  // Absent while nothing waits, which is the whole of "this day has nothing to review".
  CHECK(quiet["routines"][0]["pendingProposal"].isNull());
  CHECK_EQ(quiet["routines"][0]["revision"].asInt(), 1);
  const Json::Value& pending = waiting["routines"][0]["pendingProposal"];
  CHECK_EQ(pending["id"].asString(), std::string("prop_00000001"));
  CHECK_EQ(pending["state"].asString(), std::string("pending"));
  CHECK_EQ(pending["changeCount"].asInt(), 1);
  CHECK_EQ(pending["source"]["door"].asString(), std::string("mcp"));
  // Empty while the transport carries neither, so a card draws a truthful fallback rather than an
  // empty string where a model's name should be.
  CHECK(pending["source"]["connection"].isNull());
  CHECK(pending["source"]["agent"].isNull());
  // The head alone: a list that shipped every diff row would spend a context window drawing a dot.
  CHECK(pending["changes"].isNull());
}

// A day of the program that does not exist yet is `fresh`, and the rule calls that a record: it
// lands. A day that already stands is not this tool's, and the refusal points at the tool whose
// name is true for that case rather than quietly replaying and losing the caller's edit.
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
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{1});

  // A lost reply is resent verbatim, and this product answers a replay everywhere else — so it
  // answers one here rather than refusing the caller for doing exactly what it told them to do.
  const ToolResult replayed = h.call("create_routine", args);
  CHECK_FALSE(replayed.isError);
  CHECK_EQ(body(replayed)["revision"].asInt(), 1);
  CHECK_EQ(h.repo.routineRows.size(), std::size_t{1});

  args["name"] = "Push A — heavy";
  const ToolResult again = h.call("create_routine", args);

  CHECK(again.isError);
  CHECK(message(again).find("propose_routine_change") != std::string::npos);
  CHECK_EQ(h.repo.routineRows[0].name, std::string("Push A"));   // the edit did not land
}

// An agent copying a program out of a lifter's notebook can write the day down before it knows
// every number in it: a line with no `targetSets` is OPEN, and the rack decides. The schema stopped
// requiring the field in W10, which is what keeps an agent from inventing one — and the created day
// names the door it came through, so the routine's history never says `created by you` about a day
// somebody's Claude typed.
TEST(gym_create_routine_takes_an_open_line_and_the_history_names_the_door) {
  Harness h;
  h.repo.seed(Exercise{ExerciseId{"barbell-row"}, "Barbell Row", Pattern::pull, Equipment::barbell,
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
      h.service.routineHistory(uid(), RoutineId{"rt_00000001"});
  REQUIRE_EQ(history.size(), std::size_t{1});
  CHECK_EQ(history[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
  CHECK_EQ(history[0].movements, std::optional<int>(1));

  // And the published schema no longer demands the field, so an agent reading it does not have to
  // invent a number to satisfy the surface it is writing to.
  for (const ToolDeclaration& tool : gymToolCatalog())
    if (tool.name() == "create_routine") {
      const Json::Value& required =
          tool.descriptor["inputSchema"]["properties"]["entries"]["items"]["required"];
      REQUIRE_EQ(required.size(), 1u);
      CHECK_EQ(required[0].asString(), std::string("exerciseId"));
    }
}

// Refused at the MINT, not at the tap. A proposal a lifter reads and cannot apply is worse than no
// proposal at all: the refusal would arrive at the one moment they had already decided to trust it.
TEST(gym_a_proposal_naming_no_movement_is_refused_before_it_is_ever_minted) {
  Harness h;
  h.repo.routineRows.push_back(pushA());

  const ToolResult refused =
      h.propose("prop_00000001", "rt_00000001", oneEntry("zercher-squat", 5, 5, 82.5));

  CHECK(refused.isError);
  CHECK(message(refused).find("was not minted") != std::string::npos);
  CHECK(h.repo.proposalRows.empty());
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

// `gym:delete` buys the right to PROPOSE a destructive change and buys nothing else. The routine is
// exactly where it was when this call returns, and the diff draws every line that would go.
TEST(gym_proposing_a_removal_deletes_nothing_and_draws_what_would_go) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  const std::vector<Routine> before = h.repo.routineRows;
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["summary"] = "You have not trained this in three months.";

  const ToolResult minted = h.call("propose_routine_removal", args);

  REQUIRE(!minted.isError);
  CHECK_EQ(h.repo.routineRows, before);
  const Json::Value& proposal = body(minted)["proposal"];
  CHECK_EQ(proposal["intent"].asString(), std::string("remove"));
  CHECK_EQ(proposal["state"].asString(), std::string("pending"));
  REQUIRE_EQ(proposal["changes"].size(), 1u);
  CHECK_EQ(proposal["changes"][0]["kind"].asString(), std::string("removed"));
  CHECK_EQ(proposal["changes"][0]["exerciseId"].asString(), std::string("bench-press"));
  // §D14's *41 logged sets kept*, counted at read time so it is true when a lifter reads it.
  CHECK_EQ(proposal["changes"][0]["loggedSets"].asInt(), 0);
  CHECK(proposal["changes"][0]["after"].isNull());
}

// The removal's diff names how many sets each line keeps, because that sentence is what makes a
// removal safe to read: the day leaves the program and nothing about the log moves.
TEST(gym_a_removal_proposal_counts_the_sets_each_line_keeps) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
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

// ---- §I · a lifter's settings are not an agent's business at all -----------------------------

// NO AGENT MAY READ OR WRITE A LIFTER'S SETTINGS, and the read side of that is new: `get_preferences`
// was retired on 2026-08-13 with nothing in its place. It existed so a proposal could be checked
// against the plates a gym owned — and gym stopped keeping a plate inventory, because gyms are more
// or less the same and this product guides a program rather than managing equipment. What was left
// behind it was a rest dial and a reading unit, which are the lifter's own and not context to fetch.
// Every level is searched, because the rule is about the verb and not about which grant reaches it.
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
  CHECK_EQ(h.repo.preferenceRows.size(), std::size_t{0});
}

// The retirement ANSWERS rather than shrugging, and it is the one retirement in this catalog with no
// replacement to name — so the sentence has to say that out loud or it sends an agent hunting for
// the tool that took over. An agent written against the old catalog calls this on its first turn
// after the deploy, and this is a connected lifter's whole first experience of the change.
TEST(gym_retired_get_preferences_says_that_nothing_replaced_it) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});

  const ToolResult refused = surface.callTool("get_preferences", Json::Value(Json::objectValue),
                                              ToolCaller{uid(), parseToolScope("gym:read")});

  CHECK(refused.isError);
  CHECK(message(refused).find("retired on 2026-08-13") != std::string::npos);
  CHECK(message(refused).find("nothing replaced it") != std::string::npos);
  // Never the false reason. The level WAS granted; the tool is gone.
  CHECK(message(refused).find("granted") == std::string::npos);
  CHECK_EQ(h.tools.retirement("get_preferences")->replacement, std::string(""));
}

// The same sentence reaches a client before it calls anything, because the retirement is also in
// the paragraph every client reads at connect — pinned here beside retiredTools()'s copy so the two
// cannot drift apart.
TEST(gym_connect_paragraph_carries_the_retirement) {
  const std::string paragraph = gymInstructions();

  CHECK(paragraph.find("Retired on 2026-08-13 with NO replacement: `get_preferences`") !=
        std::string::npos);
  CHECK(paragraph.find("keeps no plate inventory") != std::string::npos);
}

// The rest dial is inherited at the rack and this server fills in nothing. An agent told otherwise
// would read a line with no `restSeconds` back off `list_routines`, find the field still empty, and
// conclude the rest it prescribed was dropped — so the routine schema says the field stays empty and
// this proves it does, with the lifter's dial armed the whole time. The dial is checked through the
// service now rather than through a tool, which is the point: no tool reaches it any more.
TEST(gym_an_armed_rest_dial_is_never_copied_into_a_routine_line_that_names_none) {
  Harness h;
  h.service.savePreferences(GymPreferences{uid(), Unit::kg, 120, true, true, false});

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
  CHECK_EQ(h.service.preferences(uid()).restSeconds, std::optional<int>(120));
}

// `gym:read` CANNOT MINT A PROPOSAL. Reading a lifter's log does not buy the right to put a card in
// their product, and the gate is the composite's rather than gym's — so it is proved by CALLING
// through the composite, not by reading the catalog. The refusal names the level, which is the one
// sentence that is TRUE here and would have been false for a retired tool.
TEST(gym_read_alone_cannot_mint_a_proposal) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";
  args["entries"] = oneEntry("bench-press", 5, 3, 87.5);

  const ToolResult refused =
      surface.callTool("propose_routine_change", args, ToolCaller{uid(), parseToolScope("gym:read")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:write") != std::string::npos);
  CHECK(h.repo.proposalRows.empty());
  // And a grant that names the level mints, through the very same door.
  CHECK_FALSE(surface
                  .callTool("propose_routine_change", args,
                            ToolCaller{uid(), parseToolScope("gym:read gym:write")})
                  .isError);
  CHECK_EQ(h.repo.proposalRows.size(), std::size_t{1});
  // The routine did not move either way.
  CHECK_EQ(h.repo.routineRows[0].revision, 1);
  CHECK_EQ(h.repo.routineRows[0].entries[0].targetWeightKg, std::optional<double>(82.5));
}

// A removal is `gym:delete`'s, and `gym:write` alone does not reach it — the levels are a grant
// vocabulary and none of the three implies another.
TEST(gym_write_alone_cannot_propose_a_removal) {
  Harness h;
  CompositeToolHost surface(std::vector<ToolModule>{{h.tools, gymInstructions()}});
  h.repo.routineRows.push_back(pushA());
  Json::Value args(Json::objectValue);
  args["id"] = "prop_00000001";
  args["routineId"] = "rt_00000001";

  const ToolResult refused = surface.callTool("propose_routine_removal", args,
                                              ToolCaller{uid(), parseToolScope("gym:write")});

  CHECK(refused.isError);
  CHECK(message(refused).find("gym:delete") != std::string::npos);
  CHECK(h.repo.proposalRows.empty());
}

// A document identical to what the routine already says proposes nothing, and a card reading
// `Apply all 0` is a notification about nothing in an app that has no notifications on purpose.
TEST(gym_a_proposal_that_changes_nothing_is_refused_rather_than_shown_to_a_lifter) {
  Harness h;
  h.repo.routineRows.push_back(pushA());
  const Json::Value document = body(h.call("list_routines", Json::Value(Json::objectValue)))
                                   ["routines"][0]["entries"];

  const ToolResult refused = h.propose("prop_00000001", "rt_00000001", document);

  CHECK(refused.isError);
  CHECK(message(refused).find("already says") != std::string::npos);
  CHECK(h.repo.proposalRows.empty());
}

// --- The read receipt, in the envelope --------------------------------------------------------
//
// §L's line — `read 214 sets · 12 weeks · 34 sessions` — is printable only because the server counted
// the rows it served. It rides HERE, in the tool's own reply, rather than in Ask's chrome, so a
// lifter's own Claude reads the same accounting the app prints, and so that no layer above can print
// a number nobody counted.

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

// A page NAMES workouts and counts their sets; it hands over no set rows, so it claims none. The
// conservative direction is the whole point: a receipt never claims a row it did not serve.
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

// The catalog and the program are not the log, so they make no claim at all — "read 0 sets" is noise
// rather than a fact, and an agent that saw it might repeat it.
TEST(gym_a_read_that_served_no_log_rows_says_nothing_about_what_it_read) {
  Harness h;
  CHECK_FALSE(body(h.call("list_exercises", Json::Value(Json::objectValue))).isMember("read"));
  CHECK_FALSE(body(h.call("list_routines", Json::Value(Json::objectValue))).isMember("read"));
}

// Provenance is a column and not a fork (W6): the same tool, called through the MCP door, mints a
// proposal that says so — and Ask's own door is what AskTools passes instead (AskServiceTest).
TEST(gym_a_proposal_minted_over_mcp_carries_the_mcp_door) {
  Harness h;
  h.repo.routineRows.push_back(pushA());

  const ToolResult minted =
      h.propose("prop_00000001", "rt_00000001", oneEntry("bench-press", 5, 3, 87.5));

  CHECK_FALSE(minted.isError);
  CHECK_EQ(body(minted)["proposal"]["source"]["door"].asString(), std::string("mcp"));
}
