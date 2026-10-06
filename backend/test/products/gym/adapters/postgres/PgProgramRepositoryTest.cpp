#include "test/products/gym/sync/GymDoorFixture.h"
#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/GymJson.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The program's store against a real server, written through MCP and Coach's door and a phone's /v1/sync.
using namespace wm::gym;
using wm::PgLease;
using wm::UserId;
using wm::parse;
using wm::gym::pgtest::benchAt;
using wm::gym::pgtest::entryAt;
using wm::gym::pgtest::kNow;
using wm::gym::pgtest::pushA;

namespace {

Routine dayOf(const UserId& owner, const std::string& id, const std::string& name,
              std::vector<RoutineEntry> entries, int position = 0,
              std::optional<std::uint64_t> lastTrainedAtMs = std::nullopt, int revision = 1) {
  return Routine{RoutineId{id}, owner, name, position, std::move(entries), lastTrainedAtMs, revision};
}

// create_routine, the MCP tool's write.
RoutineWriteOutcome mcpCreate(doortest::Harness& h, const Routine& day) {
  return h.door.createRoutine(day.user, RoutineWrite{day.id, day.name, day.position, day.entries},
                                 ProposalDoor::mcp);
}

// The day as a phone writes it through /v1/sync: its whole document, a create when `create`.
Json::Value phoneWrite(doortest::Harness& h, const Routine& day, bool create = false) {
  Json::Value fields(Json::objectValue);
  fields["name"] = day.name;
  fields["position"] = day.position;
  fields["entries"] = toJson(day)["entries"];
  for (Json::Value& entry : fields["entries"]) entry.removeMember("position");
  return h.admit(day.user, {GymDoor::delta("routine", day.id.str(), fields, create)});
}

ProposalWrite proposalOf(const std::string& id, const std::string& routine, std::vector<RoutineEntry> becomes,
                         ProposalDoor door = ProposalDoor::mcp) {
  return ProposalWrite{ProposalId{id}, RoutineId{routine}, std::nullopt, "Heavier triples.", std::move(becomes),
                       ProposalSource{door, "", "", std::nullopt}};
}

// What the door mints from `incoming` against `base`, dated `atMs`.
RoutineProposal mintedFrom(const Routine& base, const ProposalWrite& incoming, std::uint64_t atMs) {
  std::vector<RoutineChange> changes = changesBetween(base.entries, incoming.entries);
  const int counted = countedChanges(base.entries, changes, base.name, base.name);
  return RoutineProposal{ProposalHead{incoming.id, base.id, base.user, ProposalIntent::revise, ProposalState::pending,
                                      incoming.source, incoming.summary, counted, atMs, std::nullopt},
                         base.revision, base.name, base.name, std::move(changes)};
}

// gym.applyProposal or gym.dismissProposal, as a phone's push runs it.
Json::Value settled(doortest::Harness& h, const UserId& user, const std::string& command,
                    const std::string& proposal) {
  Json::Value args(Json::objectValue);
  args["proposalId"] = proposal;
  return h.door.command(user, command, args);
}

Json::Value superseded(const std::string& reason) {
  return parse(R"({"s":"refused","code":"proposal-superseded","detail":{"reason":")" + reason + R"("}})");
}

int setRowsOf(const std::string& routine, std::optional<int> position = std::nullopt) {
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  if (!position)
    return txn.exec("SELECT count(*)::int FROM gym_routine_entry_sets WHERE routine_id = $1",
                    pqxx::params{routine})[0][0].as<int>();
  return txn.exec("SELECT count(*)::int FROM gym_routine_entry_sets WHERE routine_id = $1 AND position = $2",
                  pqxx::params{routine, *position})[0][0].as<int>();
}

}

TEST(pg_gym_routine_create_is_idempotent_and_the_whole_document_round_trips) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  // The same movement twice at two positions is the case the (routine_id, position) key exists for.
  const Routine pushDay = dayOf(h.user, "rt_pg000001", "Push A",
                                {entryAt(1, "bench-press", fake::straight(5, 5, 82.5), 180),
                                 entryAt(2, "bench-press", fake::straight(3, 12, 60.0), std::nullopt),
                                 entryAt(3, "back-squat", fake::straight(3, 8, std::nullopt), std::nullopt)});

  const RoutineWriteOutcome created = mcpCreate(h, pushDay);
  const RoutineWriteOutcome replayed =
      mcpCreate(h, dayOf(h.user, "rt_pg000001", "Renamed mid-flight", {entryAt(1, "back-squat")}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushDay));
  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(replayed.routine, created.routine);   // the STORED routine, untouched
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(pushDay));
  CHECK_EQ(h.repo.program.routine(h.other, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(h.repo.program.routines(h.other), std::vector<Routine>{});
}

// `Dip 3 × max`: every set row binds a null for reps and reads back an absence, not a zero.
TEST(pg_gym_a_routine_line_with_no_rep_target_round_trips_as_a_null) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine pushDay = dayOf(h.user, "rt_pg000001", "Push A",
                                {entryAt(1, "dip", fake::straight(3, std::nullopt, std::nullopt), 180),
                                 entryAt(2, "bench-press", fake::straight(5, 5, 82.5), 180)});

  const RoutineWriteOutcome created = mcpCreate(h, pushDay);
  const std::optional<Routine> read = h.repo.program.routine(h.user, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushDay));
  REQUIRE_EQ(read, std::optional<Routine>(pushDay));
  CHECK_EQ(read->entries[0].sets, fake::straight(3, std::nullopt, std::nullopt));
  CHECK_EQ(read->entries[1].sets, fake::straight(5, 5, 82.5));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{pushDay});
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    CHECK_EQ(txn.exec("SELECT count(*)::int FROM gym_routine_entry_sets WHERE routine_id = $1 AND reps IS NULL",
                      pqxx::params{"rt_pg000001"})[0][0].as<int>(),
             3);
  }
  const Routine edited = dayOf(h.user, "rt_pg000001", "Push A",
                               {entryAt(1, "bench-press", fake::straight(5, std::nullopt, 82.5), 180)}, 0,
                               std::nullopt, 2);
  CHECK_EQ(GymDoor::refusal(phoneWrite(h, edited)), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(edited));
}

// The OPEN line: no set rows at all, so a day copied out of a notebook stores no target.
TEST(pg_gym_an_open_routine_line_round_trips_with_no_set_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine heavy = dayOf(h.user, "rt_pg000001", "Heavy Thursday",
                              {entryAt(1, "bench-press", fake::straight(5, 5, 82.5), 180),
                               entryAt(2, "dip", {}, std::nullopt)});

  const RoutineWriteOutcome created = mcpCreate(h, heavy);
  const std::optional<Routine> read = h.repo.program.routine(h.user, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(heavy));
  REQUIRE_EQ(read, std::optional<Routine>(heavy));
  CHECK_EQ(read->entries[1].sets, std::vector<SetTarget>{});
  // No rows, not a zero-valued row, for the open line; the bench line beside it holds its five.
  CHECK_EQ(setRowsOf("rt_pg000001", 2), 0);
  CHECK_EQ(setRowsOf("rt_pg000001", 1), 5);
  const StartOutcome started =
      h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, kNow, false, RoutineId{"rt_pg000001"}});
  REQUIRE(started.session.has_value());
  const std::optional<Session> logged = h.repo.log.session(h.user, SessionId{"ses_pg000001"});
  const PlanSnapshot frozen{"Heavy Thursday", {PlanEntry{ExerciseId{"bench-press"}, fake::straight(5, 5, 82.5), 180},
                                               PlanEntry{ExerciseId{"dip"}, {}, std::nullopt}}};
  CHECK_EQ(logged, std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, kNow, std::nullopt,
                                                  RoutineId{"rt_pg000001"}, frozen}));
  REQUIRE(logged.has_value());
  CHECK_EQ(logged->plan->entries[1].sets, std::vector<SetTarget>{});
}

// The id is spent across every account: a create, an edit and a delete of another account's day change nothing.
TEST(pg_gym_a_routine_id_another_account_holds_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine theirs = dayOf(h.other, "rt_pg000001", "Their plan", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, theirs).routine.has_value());

  const RoutineWriteOutcome taken = mcpCreate(h, dayOf(h.user, "rt_pg000001", "Mine", {entryAt(1, "back-squat")}));
  const Json::Value edited = phoneWrite(h, dayOf(h.user, "rt_pg000001", "Mine now", {entryAt(1, "back-squat")}));
  h.kill(h.user, "routine", "rt_pg000001");

  CHECK(taken.error == RoutineWriteError::idTaken);
  CHECK_EQ(taken.routine, std::optional<Routine>());   // never the stranger's plan
  CHECK_EQ(edited, parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(h.repo.program.routine(h.other, RoutineId{"rt_pg000001"}), std::optional<Routine>(theirs));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{});
}

// The catalog refusal leaves as a VALUE before anything is admitted; the id stays free for the next create.
TEST(pg_gym_a_routine_entry_naming_no_movement_is_refused_and_leaves_no_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;

  const RoutineWriteOutcome refused =
      mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A",
                         {entryAt(1, "bench-press"), entryAt(2, "pg-no-such-movement")}));

  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{});
  const Routine after = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  const RoutineWriteOutcome landed = mcpCreate(h, after);
  CHECK(landed.error == RoutineWriteError::none);
  CHECK_EQ(landed.routine, std::optional<Routine>(after));
}

// The same scope the set write is held to, checked on a phone's edit beside the create.
TEST(pg_gym_a_routine_entry_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(h.door.createExercise(h.other, ExerciseWrite{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                                                          Pattern::squat, Equipment::barbell, 2.5})
              .exercise.has_value());
  const Routine stored = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, stored).routine.has_value());

  const RoutineWriteOutcome created =
      mcpCreate(h, dayOf(h.user, "rt_pg000002", "Push B", {entryAt(1, "pg-their-zercher")}));
  const Json::Value edited = phoneWrite(h, dayOf(h.user, "rt_pg000001", "Push A2", {entryAt(1, "pg-their-zercher")}));

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(created.routine, std::optional<Routine>());
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000002"}), std::optional<Routine>());
  // A refused edit is refused whole: the line it would have replaced is still there, and so is the name.
  CHECK_EQ(edited, parse(R"({"s":"refused","code":"unknown-exercise"})"));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(stored));
}

// A whole-document edit: a reorder, an insertion and a deletion are one write; a line's key IS its position.
TEST(pg_gym_routine_replace_rewrites_every_line_and_a_missing_one_is_not_found) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press"), entryAt(2, "back-squat")}))
              .routine.has_value());
  // The revision moves on the lifter's own write, the token a proposal is minted against (domain/Proposal.h).
  const Routine standing = dayOf(h.user, "rt_pg000001", "Push A2",
                                 {entryAt(1, "back-squat", fake::straight(4, 6, 100.0), 240)}, 0, std::nullopt, 2);

  const Json::Value replaced = phoneWrite(h, standing);
  const Json::Value missing = phoneWrite(h, dayOf(h.user, "rt_pg000009", "Nowhere", {entryAt(1, "bench-press")}));
  const Json::Value refused =
      phoneWrite(h, dayOf(h.user, "rt_pg000001", "Push A3", {entryAt(1, "pg-no-such-movement")}));

  CHECK_EQ(GymDoor::refusal(replaced), "");
  CHECK_EQ(missing, parse(R"({"s":"refused","code":"unknown-record"})"));
  // A refused edit is refused whole: the lines, the name and the revision all stand.
  CHECK_EQ(refused, parse(R"({"s":"refused","code":"unknown-exercise"})"));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(standing));
}

TEST(pg_gym_routine_delete_cascades_its_lines_and_leaves_every_session_its_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  h.clock.now = t1 + 1'000;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, t1, false, RoutineId{"rt_pg000001"}})
              .session.has_value());
  REQUIRE(h.door.finish(h.user, SessionId{"ses_pg000001"}, t1 + 1'000).session.has_value());

  h.kill(h.user, "routine", "rt_pg000001");
  h.kill(h.user, "routine", "rt_pg000001");

  // The pointer goes and the frozen copy is what survives.
  CHECK_EQ(h.repo.log.session(h.user, SessionId{"ses_pg000001"}),
           std::optional<Session>(Session{SessionId{"ses_pg000001"}, h.user, t1, t1 + 1'000, std::nullopt, pushA(),
                                          ClosedBy::finish}));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{});
  PgLease lease{*doortest::pool()};
  pqxx::work txn{*lease};
  CHECK_EQ(txn.exec("SELECT count(*)::int FROM gym_routine_entries WHERE routine_id = $1",
                    pqxx::params{"rt_pg000001"})[0][0].as<int>(),
           0);
}

// Most recently trained first, read off the log rather than a column, ties broken by (position, id).
TEST(pg_gym_routines_are_listed_most_recently_trained_first) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const std::uint64_t t1 = 1'700'000'000'123;
  h.clock.now = t1 + 11'000;
  for (const Routine& day : {dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")}),
                             dayOf(h.user, "rt_pg000002", "Pull A", {entryAt(1, "back-squat")}),
                             dayOf(h.user, "rt_pg000003", "Legs", {entryAt(1, "back-squat")}),
                             dayOf(h.other, "rt_pg000004", "Theirs", {entryAt(1, "bench-press")})})
    REQUIRE(mcpCreate(h, day).routine.has_value());
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, t1, false, RoutineId{"rt_pg000002"}})
              .session.has_value());
  REQUIRE(h.door.finish(h.user, SessionId{"ses_pg000001"}, t1 + 1'000).session.has_value());
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000002"}, t1 + 10'000, false,
                                                RoutineId{"rt_pg000001"}})
              .session.has_value());
  REQUIRE(h.door.finish(h.user, SessionId{"ses_pg000002"}, t1 + 11'000).session.has_value());

  CHECK_EQ(h.repo.program.routines(h.user),
           (std::vector<Routine>{
               dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")}, 0, t1 + 10'000),
               dayOf(h.user, "rt_pg000002", "Pull A", {entryAt(1, "back-squat")}, 0, t1),
               dayOf(h.user, "rt_pg000003", "Legs", {entryAt(1, "back-squat")})}));
}

// The proposals newest first and the creation row under them, with the count and the door it came through.
TEST(pg_gym_a_routines_history_is_its_proposals_and_its_creation_in_one_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  // The lifter's own day, made on a phone: its creation row names no door.
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press"), entryAt(2, "back-squat")});
  CHECK_EQ(GymDoor::refusal(phoneWrite(h, base, true)), "");
  const ProposalWrite heavier = proposalOf("prop_pg000001", "rt_pg000001", {benchAt(87.5, 3)});
  REQUIRE(h.door.propose(h.user, heavier).proposal.has_value());
  // A second day, made by an AGENT: the door rides onto its creation row.
  h.clock.now = kNow + 1'000;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000002", "Typed for me", {entryAt(1, "bench-press")})).routine.has_value());

  CHECK_EQ(h.repo.program.routineHistory(h.user, RoutineId{"rt_pg000001"}),
           (std::vector<RoutineEvent>{
               RoutineEvent{RoutineEventKind::proposal, kNow, std::nullopt, std::nullopt,
                            mintedFrom(base, heavier, kNow).head},
               RoutineEvent{RoutineEventKind::created, kNow, std::nullopt, 2, std::nullopt}}));
  CHECK_EQ(h.repo.program.routineHistory(h.user, RoutineId{"rt_pg000002"}),
           (std::vector<RoutineEvent>{
               RoutineEvent{RoutineEventKind::created, kNow + 1'000, ProposalDoor::mcp, 1, std::nullopt}}));
  CHECK(h.repo.program.routineHistory(h.other, RoutineId{"rt_pg000001"}).empty());
}

// The typed diff goes down and comes back byte for byte, absences included.
TEST(pg_gym_a_proposal_round_trips_its_typed_diff_with_every_absence_intact) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  const ProposalWrite incoming = proposalOf(
      "prop_pg00001", "rt_pg000001",
      {benchAt(87.5, 3),
       RoutineEntry{2, ExerciseId{"back-squat"}, fake::straight(3, std::nullopt, std::nullopt), std::nullopt}});
  const RoutineProposal minted = mintedFrom(base, incoming, kNow);

  const ProposalMintOutcome stored = h.door.propose(h.user, incoming);

  CHECK(stored.error == ProposalMintError::none);
  REQUIRE(stored.proposal.has_value());
  CHECK_EQ(*stored.proposal, minted);
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>(minted));
  REQUIRE_EQ(stored.proposal->changes.size(), static_cast<std::size_t>(2));
  CHECK_EQ(stored.proposal->changes[1].kind, ChangeKind::added);
  CHECK_EQ(stored.proposal->changes[1].before, std::optional<EntryTargets>());
  CHECK_EQ(stored.proposal->changes[1].after,
           std::optional<EntryTargets>(EntryTargets{fake::straight(3, std::nullopt, std::nullopt), std::nullopt}));
}

// Blank names the store holds read as stored: the routines, one routine, its Coach creation and a proposal.
TEST(pg_gym_blank_stored_routine_and_proposal_names_read_as_stored) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine pushDay = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  const Routine pullDay = dayOf(h.user, "rt_pg000002", "Pull A", {entryAt(1, "back-squat")}, 1);
  REQUIRE(mcpCreate(h, pushDay).routine.has_value());
  REQUIRE(h.door.createRoutine(h.user, RoutineWrite{pullDay.id, pullDay.name, pullDay.position, pullDay.entries},
                                  ProposalDoor::ask).routine.has_value());
  const ProposalWrite heavier = proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)});
  REQUIRE(h.door.propose(h.user, heavier).proposal.has_value());
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    txn.exec("UPDATE gym_routines SET name = '   ' WHERE id IN ('rt_pg000001', 'rt_pg000002')");
    txn.exec("UPDATE gym_routine_creations SET routine = jsonb_set(routine, '{name}', '\"\\t\"') "
             "WHERE routine_id = 'rt_pg000002'");
    txn.exec("UPDATE gym_proposals SET base_name = '   ', proposed_name = $1 WHERE id = 'prop_pg00001'",
             pqxx::params{"\xE3\x80\x80"});   // U+3000, past the ASCII trim
    txn.commit();
  }
  const Routine push{Stored{}, pushDay.id, h.user, "", 0, pushDay.entries};
  const Routine pull{Stored{}, pullDay.id, h.user, "", 1, pullDay.entries};
  const RoutineProposal minted = mintedFrom(pushDay, heavier, kNow);

  CHECK_EQ(h.repo.program.routines(h.user), (std::vector<Routine>{push, pull}));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(push));
  CHECK_EQ(h.repo.program.routineCreation(h.user, RoutineId{"rt_pg000002"}), std::optional<Routine>(pull));
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}),
           std::optional<RoutineProposal>(
               RoutineProposal{Stored{}, minted.head, minted.baseRevision, "", "\xE3\x80\x80", minted.changes}));
}

// A second proposal from the same door settles the first, and the replaced row says so even once the routine moves.
TEST(pg_gym_one_pending_proposal_per_routine_and_door_and_the_old_one_drops_into_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);

  const ProposalMintOutcome second = h.door.propose(h.user, proposalOf("prop_pg00002", "rt_pg000001", {benchAt(90.0, 3)}));
  const ProposalMintOutcome ask =
      h.door.propose(h.user, proposalOf("prop_pg00003", "rt_pg000001", {benchAt(92.5, 3)}, ProposalDoor::ask));

  CHECK(second.error == ProposalMintError::none);
  CHECK(ask.error == ProposalMintError::none);
  const std::vector<ProposalHead> all =
      h.repo.program.proposalHeads(h.user, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(all.size(), static_cast<std::size_t>(3));
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}).size(), static_cast<std::size_t>(2));
  for (const ProposalHead& head : all)
    if (head.id == ProposalId{"prop_pg00001"}) {
      CHECK_EQ(head.state, ProposalState::superseded);
      CHECK_EQ(head.settledAtMs, std::optional<std::uint64_t>(kNow));
    }
  // The replaced row records who replaced it; the two still pending record nothing.
  {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    const pqxx::result reasons = txn.exec(
        "SELECT id, superseded_by FROM gym_proposals WHERE user_id = $1::uuid ORDER BY id", pqxx::params{h.user.str()});
    REQUIRE_EQ(reasons.size(), static_cast<std::size_t>(3));
    CHECK_EQ(reasons[0]["superseded_by"].as<std::string>(), std::string("prop_pg00002"));
    CHECK(reasons[1]["superseded_by"].is_null());
    CHECK(reasons[2]["superseded_by"].is_null());
  }
  h.clock.now = kNow + 60'000;
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00001"), superseded("replaced"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00001"), superseded("replaced"));
  h.clock.now = kNow + 120'000;
  CHECK_EQ(GymDoor::refusal(settled(h, h.user, "gym.applyProposal", "prop_pg00002")), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}).value().revision, 2);
  h.clock.now = kNow + 180'000;
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00001"), superseded("replaced"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00001"), superseded("replaced"));
  // The Ask-door proposal was superseded by the APPLY (the routine moved), and says that.
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00003"), superseded("routine-changed"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00003"), superseded("routine-changed"));
}

// A row superseded with no reason recorded says only that, until the routine moves.
TEST(pg_gym_a_legacy_superseded_row_says_only_that_until_the_routine_moves) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);
  Json::Value settle(Json::objectValue);
  settle["state"] = "superseded";
  settle["settledAt"] = Json::UInt64(kNow);
  GymDoor::requireOk(h.admit(h.user, {GymDoor::delta("proposal", "prop_pg00001", settle)}));

  h.clock.now = kNow + 60'000;
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00001"), superseded("superseded"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00001"), superseded("superseded"));
  h.clock.now = kNow + 120'000;
  CHECK_EQ(GymDoor::refusal(phoneWrite(
               h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press", fake::straight(5, 5, 85.0), 180)}))),
           "");
  h.clock.now = kNow + 180'000;
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00001"), superseded("routine-changed"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00001"), superseded("routine-changed"));
}

// A replay reads back the proposal already waiting rather than superseding it with itself.
TEST(pg_gym_a_replayed_mint_reads_back_the_stored_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  const ProposalWrite incoming = proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)});
  REQUIRE(h.door.propose(h.user, incoming).proposal.has_value());
  h.clock.now = kNow + 60'000;

  const ProposalMintOutcome replayed = h.door.propose(h.user, incoming);

  CHECK(replayed.error == ProposalMintError::none);
  CHECK_EQ(replayed.proposal, std::optional<RoutineProposal>(mintedFrom(base, incoming, kNow)));
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}),
           std::vector<ProposalHead>{mintedFrom(base, incoming, kNow).head});
}

// Every refusal the store alone can know, each as a VALUE, the unknown movement refused at the MINT.
TEST(pg_gym_a_proposal_is_refused_for_a_spent_id_an_unknown_routine_and_an_unseen_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  REQUIRE(mcpCreate(h, dayOf(h.other, "rt_pg000009", "Their plan", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.createExercise(h.other, ExerciseWrite{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                                                          Pattern::squat, Equipment::barbell, 2.5})
              .exercise.has_value());
  REQUIRE(h.door.propose(h.other, proposalOf("prop_pg00009", "rt_pg000009", {benchAt(87.5, 3)})).proposal);

  const ProposalMintOutcome spent = h.door.propose(h.user, proposalOf("prop_pg00009", "rt_pg000001", {benchAt(87.5, 3)}));
  const ProposalMintOutcome theirs = h.door.propose(h.user, proposalOf("prop_pg00002", "rt_pg000009", {benchAt(87.5, 3)}));
  const ProposalMintOutcome unseen = h.door.propose(
      h.user, proposalOf("prop_pg00003", "rt_pg000001",
                         {RoutineEntry{1, ExerciseId{"pg-their-zercher"}, fake::straight(3, 8, 100.0), 180}}));

  CHECK(spent.error == ProposalMintError::idTaken);
  CHECK(theirs.error == ProposalMintError::unknownRoutine);
  CHECK(unseen.error == ProposalMintError::unknownExercise);
  // The refused mint wrote nothing: no header, no lines, and the next mint lands.
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00003"}), std::optional<RoutineProposal>());
  const ProposalWrite next = proposalOf("prop_pg00004", "rt_pg000001", {benchAt(87.5, 3)});
  const ProposalMintOutcome landed = h.door.propose(h.user, next);
  CHECK(landed.error == ProposalMintError::none);
  CHECK_EQ(landed.proposal, std::optional<RoutineProposal>(mintedFrom(base, next, kNow)));
}

// A refused mint spends nothing: the supersede rides on the mint's own admission and goes with it.
TEST(pg_gym_a_refused_mint_leaves_the_pending_card_it_could_not_replace) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(mcpCreate(h, dayOf(h.other, "rt_pg000009", "Their plan", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.other, proposalOf("prop_pg00009", "rt_pg000009", {benchAt(87.5, 3)})).proposal);
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);

  const ProposalMintOutcome stranger = h.door.propose(h.user, proposalOf("prop_pg00009", "rt_pg000001", {benchAt(90.0, 3)}));
  const ProposalMintOutcome reused = h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(95.0, 3)}));

  CHECK(stranger.error == ProposalMintError::idTaken);
  CHECK(reused.error == ProposalMintError::idReused);
  // Neither refusal moved anything: the card the lifter can see is still waiting.
  const std::vector<ProposalHead> waiting = h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true});
  REQUIRE_EQ(waiting.size(), static_cast<std::size_t>(1));
  CHECK_EQ(waiting[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(waiting[0].state, ProposalState::pending);
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}).value().changes.at(0).after,
           std::optional<EntryTargets>(EntryTargets{fake::straight(5, 3, 87.5), 180}));
  CHECK_EQ(h.repo.program.proposalHeads(h.other, ProposalQuery{std::nullopt, true}).size(), static_cast<std::size_t>(1));
}

// A card dies only when the document or the name actually moved.
TEST(pg_gym_a_put_that_lands_the_same_document_moves_no_revision_and_settles_no_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);
  h.clock.now = kNow + 60'000;

  CHECK_EQ(GymDoor::refusal(phoneWrite(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")}))), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})));
  CHECK_EQ(GymDoor::refusal(phoneWrite(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")}, 3))), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")}, 3)));
  CHECK_EQ(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}).size(), static_cast<std::size_t>(1));

  h.clock.now = kNow + 120'000;
  const Routine edited = dayOf(h.user, "rt_pg000001", "Push A",
                               {entryAt(1, "bench-press", fake::straight(5, 5, 85.0))}, 3, std::nullopt, 2);
  CHECK_EQ(GymDoor::refusal(phoneWrite(h, edited)), "");

  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(edited));
  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, true}).empty());
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}).value().head.state, ProposalState::superseded);
}

// The tap: the whole document, the revision moved and the row dated; a second tap replays.
TEST(pg_gym_applying_a_proposal_writes_the_document_moves_the_revision_and_dates_the_record) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  const ProposalWrite incoming = proposalOf(
      "prop_pg00001", "rt_pg000001", {benchAt(87.5, 3), entryAt(2, "back-squat", fake::straight(3, 8, 100.0), 240)});
  REQUIRE(h.door.propose(h.user, incoming).proposal.has_value());
  const Routine becomes = dayOf(h.user, "rt_pg000001", "Push A",
                                {benchAt(87.5, 3), entryAt(2, "back-squat", fake::straight(3, 8, 100.0), 240)}, 0,
                                std::nullopt, 2);
  RoutineProposal applied = mintedFrom(base, incoming, kNow);
  applied.head.state = ProposalState::applied;
  applied.head.settledAtMs = kNow + 60'000;

  h.clock.now = kNow + 60'000;
  const Json::Value tapped = settled(h, h.user, "gym.applyProposal", "prop_pg00001");
  h.clock.now = kNow + 120'000;
  const Json::Value again = settled(h, h.user, "gym.applyProposal", "prop_pg00001");

  CHECK_EQ(GymDoor::refusal(tapped), "");
  CHECK_EQ(GymDoor::refusal(again), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(becomes));
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>(applied));
}

// The lifter's own edit moves the revision and supersedes what was pending, in the SAME admission.
TEST(pg_gym_the_lifters_own_write_supersedes_a_pending_proposal_and_the_tap_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);
  const Routine rewritten = dayOf(h.user, "rt_pg000001", "Push A",
                                  {entryAt(1, "bench-press", fake::straight(5, 5, 85.0), 180)}, 0, std::nullopt, 2);

  h.clock.now = kNow + 60'000;
  const Json::Value written = phoneWrite(h, rewritten);
  h.clock.now = kNow + 120'000;
  const Json::Value refused = settled(h, h.user, "gym.applyProposal", "prop_pg00001");

  CHECK_EQ(GymDoor::refusal(written), "");
  CHECK_EQ(refused, superseded("routine-changed"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00001"), superseded("routine-changed"));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(rewritten));
  const std::vector<ProposalHead> history =
      h.repo.program.proposalHeads(h.user, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
}

// Dismissing keeps the card; the other decision is refused and the same one replays.
TEST(pg_gym_dismissing_keeps_the_card_and_refuses_the_other_decision) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  const ProposalWrite incoming = proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)});
  REQUIRE(h.door.propose(h.user, incoming).proposal.has_value());
  RoutineProposal dismissed = mintedFrom(base, incoming, kNow);
  dismissed.head.state = ProposalState::dismissed;
  dismissed.head.settledAtMs = kNow + 60'000;

  h.clock.now = kNow + 60'000;
  const Json::Value first = settled(h, h.user, "gym.dismissProposal", "prop_pg00001");
  h.clock.now = kNow + 120'000;
  const Json::Value again = settled(h, h.user, "gym.dismissProposal", "prop_pg00001");
  h.clock.now = kNow + 180'000;
  const Json::Value tapped = settled(h, h.user, "gym.applyProposal", "prop_pg00001");

  CHECK_EQ(GymDoor::refusal(first), "");
  CHECK_EQ(GymDoor::refusal(again), "");
  CHECK_EQ(tapped, parse(R"({"s":"refused","code":"proposal-settled","detail":{"state":"dismissed"}})"));
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>(dismissed));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(base));
}

// The kept-set count, counted at READ time against the live log.
TEST(pg_gym_a_removed_line_counts_the_sets_it_keeps_at_read_time) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  h.clock.now = kNow + 120'000;
  REQUIRE(h.door.start(h.user, SessionStart{SessionId{"ses_pg000001"}, kNow, false, std::nullopt}).session);
  for (const auto& [id, at] : {std::pair{"set_pg000001", kNow + 60'000}, std::pair{"set_pg000002", kNow + 120'000}})
    REQUIRE(h.door.append(h.user, SessionId{"ses_pg000001"},
                              SetWrite{SetId{id}, ExerciseId{"bench-press"}, 82.5, 8, SetKind::working, std::nullopt, "", at})
                .set.has_value());
  REQUIRE(h.door.proposeRemoval(h.user, ProposalId{"prop_pg00001"}, RoutineId{"rt_pg000001"}, "Drop it.",
                                   ProposalSource{ProposalDoor::mcp, "", "", std::nullopt})
              .proposal.has_value());

  const std::optional<RoutineProposal> read = h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"});

  REQUIRE(read.has_value());
  CHECK_EQ(read->head.intent, ProposalIntent::remove);
  REQUIRE_EQ(read->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(read->changes[0].kind, ChangeKind::removed);
  CHECK_EQ(read->changes[0].loggedSets, 2);
}

// Applying a removal takes the day out of the program and its proposals with it; the tap again finds nothing.
TEST(pg_gym_applying_a_removal_takes_the_routine_and_its_ledger_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.proposeRemoval(h.user, ProposalId{"prop_pg00001"}, RoutineId{"rt_pg000001"}, "Drop it.",
                                   ProposalSource{ProposalDoor::mcp, "", "", std::nullopt})
              .proposal.has_value());

  h.clock.now = kNow + 60'000;
  const Json::Value tapped = settled(h, h.user, "gym.applyProposal", "prop_pg00001");

  CHECK_EQ(GymDoor::refusal(tapped), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>());
  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00001"),
           parse(R"({"s":"refused","code":"record-dead"})"));
}

// Absent, another account's and never-existed are ONE answer on every proposal door.
TEST(pg_gym_a_proposal_another_account_holds_resolves_to_nothing_on_every_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.other, "rt_pg000009", "Their plan", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.other, proposalOf("prop_pg00009", "rt_pg000009", {benchAt(87.5, 3)})).proposal);
  const Routine theirs = h.repo.program.routine(h.other, RoutineId{"rt_pg000009"}).value();
  const RoutineProposal waiting = h.repo.program.proposal(h.other, ProposalId{"prop_pg00009"}).value();

  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00009"}), std::optional<RoutineProposal>());
  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00009"), parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(settled(h, h.user, "gym.dismissProposal", "prop_pg00009"), parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(settled(h, h.user, "gym.applyProposal", "prop_pg00404"), parse(R"({"s":"refused","code":"unknown-record"})"));
  CHECK_EQ(h.repo.program.routine(h.other, RoutineId{"rt_pg000009"}), std::optional<Routine>(theirs));
  CHECK_EQ(h.repo.program.proposal(h.other, ProposalId{"prop_pg00009"}), std::optional<RoutineProposal>(waiting));
}

// Deleting a routine takes its ledger with it.
TEST(pg_gym_deleting_a_routine_takes_its_proposals_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")})).routine.has_value());
  REQUIRE(h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {benchAt(87.5, 3)})).proposal);

  h.kill(h.user, "routine", "rt_pg000001");

  CHECK(h.repo.program.proposalHeads(h.user, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>());
}

// The scheme is one row per set, read back in set_index order, and an open line has none.
TEST(pg_gym_a_ramp_round_trips_in_order_and_an_open_line_beside_it_reads_back_empty) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine lowerA = dayOf(h.user, "rt_pg000001", "Lower A",
                               {entryAt(1, "back-squat", fake::ramp(), 240), entryAt(2, "bench-press", {}, 180)});

  const RoutineWriteOutcome created = mcpCreate(h, lowerA);

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(lowerA));
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(lowerA));
  CHECK_EQ(h.repo.program.routines(h.user), std::vector<Routine>{lowerA});
  CHECK_EQ(setRowsOf("rt_pg000001", 1), 5);
  CHECK_EQ(setRowsOf("rt_pg000001", 2), 0);
}

// An edit lays the scheme down again: a line that shrinks leaves exactly its new sets behind.
TEST(pg_gym_routine_replace_takes_the_old_scheme_rows_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  REQUIRE(mcpCreate(h, dayOf(h.user, "rt_pg000001", "Lower A",
                             {entryAt(1, "back-squat", fake::ramp(), 240), entryAt(2, "bench-press")}))
              .routine.has_value());
  const int before = setRowsOf("rt_pg000001");
  const Routine edited = dayOf(h.user, "rt_pg000001", "Lower A",
                               {entryAt(1, "back-squat", fake::straight(3, 5, 100.0), 240)}, 0, std::nullopt, 2);

  const Json::Value written = phoneWrite(h, edited);

  CHECK_EQ(before, 10);
  CHECK_EQ(GymDoor::refusal(written), "");
  CHECK_EQ(h.repo.program.routine(h.user, RoutineId{"rt_pg000001"}), std::optional<Routine>(edited));
  CHECK_EQ(setRowsOf("rt_pg000001"), 3);
  CHECK_EQ(setRowsOf("rt_pg000001", 1), 3);
}

// Both sides carry the whole scheme; an open side reads back empty, and `kind` alone says which side is missing.
TEST(pg_gym_a_proposal_carries_a_ramp_on_both_sides_and_an_open_line_reads_back_empty) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A",
                             {entryAt(1, "back-squat", fake::ramp(), 240), entryAt(2, "bench-press", {}, 180)});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  std::vector<SetTarget> heavier = fake::ramp();
  heavier[3] = SetTarget{1, 102.5};
  ProposalWrite incoming = proposalOf("prop_pg00001", "rt_pg000001",
                                      {entryAt(1, "back-squat", heavier, 240), entryAt(2, "bench-press", {}, 180)});
  incoming.summary = "Top single up.";
  const RoutineProposal minted = mintedFrom(base, incoming, kNow);

  const ProposalMintOutcome stored = h.door.propose(h.user, incoming);
  const std::optional<RoutineProposal> read = h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"});

  CHECK(stored.error == ProposalMintError::none);
  CHECK_EQ(stored.proposal, std::optional<RoutineProposal>(minted));
  REQUIRE(read.has_value());
  CHECK_EQ(*read, minted);
  REQUIRE_EQ(read->changes.size(), static_cast<std::size_t>(2));
  CHECK_EQ(read->changes[0].kind, ChangeKind::retargeted);
  CHECK_EQ(read->changes[0].before, std::optional<EntryTargets>(EntryTargets{fake::ramp(), 240}));
  CHECK_EQ(read->changes[0].after, std::optional<EntryTargets>(EntryTargets{heavier, 240}));
  CHECK_EQ(read->changes[1].kind, ChangeKind::kept);
  CHECK_EQ(read->changes[1].before, std::optional<EntryTargets>(EntryTargets{{}, 180}));
  CHECK_EQ(read->changes[1].after, std::optional<EntryTargets>(EntryTargets{{}, 180}));
}

// A replay matches the scheme set for set: one set moved is a different document under a spent id.
TEST(pg_gym_a_proposal_replay_matches_the_scheme_set_for_set) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  doortest::Harness h;
  const Routine base = dayOf(h.user, "rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  REQUIRE(mcpCreate(h, base).routine.has_value());
  std::vector<SetTarget> oneSetOff = fake::ramp();
  oneSetOff[2] = SetTarget{3, 92.5};
  const ProposalWrite incoming = proposalOf("prop_pg00001", "rt_pg000001", {entryAt(1, "bench-press", fake::ramp(), 180)});
  const RoutineProposal minted = mintedFrom(base, incoming, kNow);
  REQUIRE(h.door.propose(h.user, incoming).proposal.has_value());

  const ProposalMintOutcome replayed = h.door.propose(h.user, incoming);
  const ProposalMintOutcome moved =
      h.door.propose(h.user, proposalOf("prop_pg00001", "rt_pg000001", {entryAt(1, "bench-press", oneSetOff, 180)}));

  CHECK(replayed.error == ProposalMintError::none);
  CHECK_EQ(replayed.proposal, std::optional<RoutineProposal>(minted));
  CHECK(moved.error == ProposalMintError::idReused);
  CHECK_EQ(moved.proposal, std::optional<RoutineProposal>());
  CHECK_EQ(h.repo.program.proposal(h.user, ProposalId{"prop_pg00001"}), std::optional<RoutineProposal>(minted));
}
