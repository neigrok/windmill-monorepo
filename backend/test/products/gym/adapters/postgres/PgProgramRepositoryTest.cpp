#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"

#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The program's store against a real server: routines as one document over two tables, and the
// proposal ledger against them.
using namespace wm::gym;
using namespace wm::gym::pgtest;

// ---- routines: two tables, one document, one transaction -----------------------------------

// The row and its lines land together, and the id is the idempotency key: a create replayed after a
// lost reply reads back what landed instead of appending a second copy of every line.
TEST(pg_gym_routine_create_is_idempotent_and_the_whole_document_round_trips) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  // The same movement twice at two positions — bench heavy, then bench back-off — is the case the
  // (routine_id, position) key exists for, and it must survive a round trip in order.
  const Routine pushA = routineAt("rt_pg000001", "Push A",
                                  {entryAt(1, "bench-press", 5, 5, 82.5, 180),
                                   entryAt(2, "bench-press", 3, 12, 60.0, std::nullopt),
                                   entryAt(3, "back-squat", 3, 8, std::nullopt, std::nullopt)});

  RoutineWriteOutcome created = inserted(repo, pushA);
  RoutineWriteOutcome replayed = inserted(repo, 
      routineAt("rt_pg000001", "Renamed mid-flight", {entryAt(1, "back-squat")}));

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushA));
  CHECK(replayed.error == RoutineWriteError::none);
  CHECK_EQ(replayed.routine, created.routine);   // the STORED routine, untouched
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(pushA));
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(repo.routines(wm::UserId{kOther}), std::vector<Routine>{});
}

// `Chin-up 3 × max` against the real column. target_reps dropped its NOT NULL for this line, so the
// write binds a null and the read hands back an absence — not a zero, and not the 8 the column used
// to default to. The CHECK still holds for every line that names a target.
TEST(pg_gym_a_routine_line_with_no_rep_target_round_trips_as_a_null) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  const Routine pushA =
      routineAt("rt_pg000001", "Push A",
                {entryAt(1, "pull-up", 3, std::nullopt, std::nullopt, 180),
                 entryAt(2, "bench-press", 5, 5, 82.5, 180)});

  RoutineWriteOutcome created = inserted(repo, pushA);
  std::optional<Routine> read = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(pushA));
  CHECK_EQ(read, std::optional<Routine>(pushA));
  CHECK_EQ(read->entries[0].targetReps, std::optional<int>());
  CHECK_EQ(read->entries[1].targetReps, std::optional<int>(5));
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{pushA});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT count(*)::int AS n FROM gym_routine_entries "
                           "WHERE routine_id = $1 AND target_reps IS NULL",
                           "rt_pg000001")[0]["n"]
                 .as<int>(),
             1);
  }
  // A replace writes the null too — the whole document is laid down again, absences and all.
  RoutineWriteOutcome replaced = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press", 5, std::nullopt, 82.5, 180)}),
      kNow, std::nullopt);
  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine->entries[0].targetReps, std::optional<int>());
}

// The OPEN line against the real column, and it is the same move target_reps made: target_sets
// dropped its NOT NULL and its default of 3, so a day copied out of a notebook stores the line with
// no target at all rather than the three sets nobody asked for. The CHECK still holds for every
// line that names one.
TEST(pg_gym_an_open_routine_line_round_trips_as_a_null_target_sets) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  const Routine heavy = routineAt(
      "rt_pg000001", "Heavy Thursday",
      {entryAt(1, "bench-press", 5, 5, 82.5, 180),
       entryAt(2, "barbell-row", std::nullopt, std::nullopt, std::nullopt, std::nullopt)});

  RoutineWriteOutcome created = inserted(repo, heavy);
  std::optional<Routine> read = repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});

  CHECK(created.error == RoutineWriteError::none);
  CHECK_EQ(created.routine, std::optional<Routine>(heavy));
  CHECK_EQ(read, std::optional<Routine>(heavy));
  CHECK_EQ(read->entries[1].targetSets, std::optional<int>());
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    // A NULL and not a zero: the column would take a zero and the row would then be asking for
    // nothing, which is a target rather than the absence of one.
    CHECK_EQ(w.exec_params("SELECT count(*)::int AS n FROM gym_routine_entries "
                           "WHERE routine_id = $1 AND target_sets IS NULL",
                           "rt_pg000001")[0]["n"]
                 .as<int>(),
             1);
  }
  // And the session started under it freezes the absence, so the logger asks at the rack.
  log.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, kNow, std::nullopt,
                             RoutineId{"rt_pg000001"}, snapshotOf(*read)});
  CHECK_EQ(log.session(wm::UserId{kUser}, SessionId{"ses_pg000001"})->plan->entries[1].sets,
           std::optional<int>());
}

TEST(pg_gym_a_routine_id_another_account_holds_resolves_to_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, Routine{RoutineId{"rt_pg000001"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});

  RoutineWriteOutcome taken = inserted(repo, routineAt("rt_pg000001", "Mine", {entryAt(1, "back-squat")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Mine now", {entryAt(1, "back-squat")}), kNow, std::nullopt);

  CHECK(taken.error == RoutineWriteError::idTaken);
  CHECK_EQ(taken.routine, std::optional<Routine>());   // never the stranger's plan
  CHECK(replaced.error == RoutineWriteError::notFound);
  CHECK_FALSE(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000001"})->name,
           std::string("Their plan"));
}

// The catalog is the store's own fact and it leaves as a VALUE, exactly as a set's does — asked
// outright by the statement rather than caught off the foreign key, so "you may not see it" is
// sayable at all. The document is one transaction, so a refused line rolls back and leaves NO
// routine row behind — not even the header.
TEST(pg_gym_a_routine_entry_naming_no_movement_is_refused_and_leaves_no_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};

  RoutineWriteOutcome refused = inserted(repo, 
      routineAt("rt_pg000001", "Push A",
                {entryAt(1, "bench-press"), entryAt(2, "pg-no-such-movement")}));

  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{});
  // The rolled-back transaction was the refused write's alone: the connection is reusable at once.
  RoutineWriteOutcome after = inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  CHECK(after.error == RoutineWriteError::none);
  CHECK_EQ(after.routine->entries.size(), static_cast<std::size_t>(1));
}

// The same scope the set write is held to, on the other door a movement id travels through — and
// the replace half is checked beside the create, because both write the same whole document and a
// gate on only one of them is no gate at all.
TEST(pg_gym_a_routine_entry_may_not_name_another_accounts_private_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgCatalogRepository catalog{wm::pgTestPool()};
  catalog.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                               Pattern::squat, Equipment::barbell, 2.5, true});
  const Routine stored = routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")});
  inserted(repo, stored);

  RoutineWriteOutcome created =
      inserted(repo, routineAt("rt_pg000002", "Push B", {entryAt(1, "pg-their-zercher")}));
  RoutineWriteOutcome replaced =
      repo.replaceRoutine(routineAt("rt_pg000001", "Push A2", {entryAt(1, "pg-their-zercher")}),
                          kNow, std::nullopt);

  CHECK(created.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(created.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000002"}), std::optional<Routine>());
  // A refused replace rolls back whole: the line it deleted is still there, and so is the name.
  CHECK(replaced.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(replaced.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>(stored));
}

// A whole-document replace: a reorder, an insertion and a deletion are one write, and churning the
// lines costs no identity because a line has none — its key IS its position.
TEST(pg_gym_routine_replace_rewrites_every_line_and_a_missing_one_is_not_found) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A",
                               {entryAt(1, "bench-press"), entryAt(2, "back-squat")}));
  // The revision moves on the lifter's own write — the token a proposal is minted against and
  // superseded by (domain/Proposal.h) — so what the store hands back stands one past what was sent.
  const Routine rewritten = routineAt("rt_pg000001", "Push A2",
                                      {entryAt(1, "back-squat", 4, 6, 100.0, 240)});
  const Routine standing = Routine{rewritten.id,      rewritten.user,
                                   rewritten.name,    rewritten.position,
                                   rewritten.entries, rewritten.lastTrainedAtMs,
                                   2};

  RoutineWriteOutcome replaced = repo.replaceRoutine(rewritten, kNow, std::nullopt);
  RoutineWriteOutcome missing =
      repo.replaceRoutine(routineAt("rt_pg000009", "Nowhere", {entryAt(1, "bench-press")}), kNow, std::nullopt);
  RoutineWriteOutcome refused = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A3", {entryAt(1, "pg-no-such-movement")}), kNow, std::nullopt);

  CHECK(replaced.error == RoutineWriteError::none);
  CHECK_EQ(replaced.routine, std::optional<Routine>(standing));
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(standing));
  CHECK(missing.error == RoutineWriteError::notFound);
  // A refused replace rolls back whole: the lines it deleted are still there, the name is, and so
  // is the revision — a rolled-back write moves no token.
  CHECK(refused.error == RoutineWriteError::unknownExercise);
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
           std::optional<Routine>(standing));
}

TEST(pg_gym_routine_delete_cascades_its_lines_and_leaves_every_session_its_snapshot) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  log.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000001"}, pushA()});
  log.close(SessionId{"ses_pg000001"}, t1 + 1'000, ClosedBy::finish);

  CHECK(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));
  CHECK_FALSE(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));

  std::optional<Session> ran = log.session(wm::UserId{kUser}, SessionId{"ses_pg000001"});
  REQUIRE(ran.has_value());
  CHECK_EQ(ran->routine, std::optional<RoutineId>());          // on delete set null
  CHECK_EQ(ran->plan, std::optional<PlanSnapshot>(pushA()));   // the copy is what survives
  CHECK_EQ(repo.routines(wm::UserId{kUser}), std::vector<Routine>{});
  {
    wm::PgLease c{*wm::pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec_params("SELECT 1 FROM gym_routine_entries WHERE routine_id = $1",
                           "rt_pg000001")
                 .size(),
             static_cast<std::size_t>(0));
  }
}

// The routines screen's order, read off the log rather than a column: most recently trained first,
// never-trained after them, ties broken by (position, id) so the walk is deterministic.
TEST(pg_gym_routines_are_listed_most_recently_trained_first) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  const std::uint64_t t1 = 1'700'000'000'123;
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, routineAt("rt_pg000002", "Pull A", {entryAt(1, "back-squat")}));
  inserted(repo, routineAt("rt_pg000003", "Legs", {entryAt(1, "back-squat")}));
  log.insertSession(Session{SessionId{"ses_pg000001"}, wm::UserId{kUser}, t1, std::nullopt,
                             RoutineId{"rt_pg000002"}, PlanSnapshot{"Pull A", {}}});
  log.close(SessionId{"ses_pg000001"}, t1 + 1'000, ClosedBy::finish);
  log.insertSession(Session{SessionId{"ses_pg000002"}, wm::UserId{kUser}, t1 + 10'000,
                             std::nullopt, RoutineId{"rt_pg000001"}, pushA()});
  log.close(SessionId{"ses_pg000002"}, t1 + 11'000, ClosedBy::finish);
  // Another account training its own routine cannot move this account's order.
  inserted(repo, Routine{RoutineId{"rt_pg000004"}, wm::UserId{kOther}, "Theirs", 0,
                             {entryAt(1, "bench-press")}});

  std::vector<Routine> listed = repo.routines(wm::UserId{kUser});

  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(3));
  CHECK_EQ(listed[0].name, std::string("Push A"));
  CHECK_EQ(listed[0].lastTrainedAtMs, std::optional<std::uint64_t>(t1 + 10'000));
  CHECK_EQ(listed[1].name, std::string("Pull A"));
  CHECK_EQ(listed[1].lastTrainedAtMs, std::optional<std::uint64_t>(t1));
  CHECK_EQ(listed[2].name, std::string("Legs"));
  CHECK_EQ(listed[2].lastTrainedAtMs, std::optional<std::uint64_t>());
  CHECK_EQ(listed[0].entries, std::vector<RoutineEntry>{entryAt(1, "bench-press")});
}

// ---- the proposal ledger, against the real store ----------------------------------------------

// The day's own history, over the two tables it lives in: the proposals newest first and the
// creation row under them, with the count the day was BUILT with and the door it came through.
TEST(pg_gym_a_routines_history_is_its_proposals_and_its_creation_in_one_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A",
                           {entryAt(1, "bench-press"), entryAt(2, "back-squat")}));
  repo.insertProposal(proposalAt("prop_pg000001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  // A second day, made by an AGENT: the door rides onto its creation row, so nothing on screen can
  // say `created by you` about a program somebody's Claude typed.
  repo.insertRoutine(routineAt("rt_pg000002", "Typed for me", {entryAt(1, "bench-press")}),
                     ProposalDoor::mcp, kNow + 1'000);

  const std::vector<RoutineEvent> history =
      repo.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  const std::vector<RoutineEvent> typed =
      repo.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000002"});

  REQUIRE_EQ(history.size(), static_cast<std::size_t>(2));
  CHECK(history[0].kind == RoutineEventKind::proposal);
  CHECK_EQ(history[0].proposal->id, ProposalId{"prop_pg000001"});
  CHECK(history[1].kind == RoutineEventKind::created);
  CHECK_EQ(history[1].atMs, kBuiltAtMs);
  CHECK_EQ(history[1].movements, std::optional<int>(2));
  CHECK_EQ(history[1].door, std::optional<ProposalDoor>());   // the lifter's own hand
  REQUIRE_EQ(typed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(typed[0].door, std::optional<ProposalDoor>(ProposalDoor::mcp));
  CHECK_EQ(typed[0].atMs, kNow + 1'000);
  // Another account's routine has no history at all, which is the one fact every read here gives.
  CHECK(repo.routineHistory(wm::UserId{kOther}, RoutineId{"rt_pg000001"}).empty());
}

// The whole round trip through real columns: the typed diff goes down and comes back byte for byte,
// absences included — a null rest, a null rep target, and the whole `before` side missing on a line
// the proposal adds.
TEST(pg_gym_a_proposal_round_trips_its_typed_diff_with_every_absence_intact) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  const RoutineProposal minted = proposalAt(
      "prop_pg00001", "rt_pg000001", 1,
      {benchAt(87.5, 3),
       RoutineEntry{2, ExerciseId{"back-squat"}, 3, std::nullopt, std::nullopt, std::nullopt}});

  ProposalMintOutcome stored = repo.insertProposal(minted);

  CHECK(stored.error == ProposalMintError::none);
  REQUIRE(stored.proposal.has_value());
  CHECK_EQ(*stored.proposal, minted);
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}),
           std::optional<RoutineProposal>(minted));
  // The added line carries no `before` at all, and its three absences are absences.
  CHECK_EQ(stored.proposal->changes[1].kind, ChangeKind::added);
  CHECK_EQ(stored.proposal->changes[1].before, std::optional<EntryTargets>());
  CHECK_EQ(stored.proposal->changes[1].after,
           std::optional<EntryTargets>(EntryTargets{3, std::nullopt, std::nullopt, std::nullopt}));
}

// The partial unique index is the arbiter, not an application check: a second proposal from the
// same door settles the first as superseded and lands beside it in the history.
TEST(pg_gym_one_pending_proposal_per_routine_and_door_and_the_old_one_drops_into_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  ProposalMintOutcome second =
      repo.insertProposal(proposalAt("prop_pg00002", "rt_pg000001", 1, {benchAt(90.0, 3)}));
  // A different DOOR is a different pending slot — W7's Ask mints through this same object.
  ProposalMintOutcome ask = repo.insertProposal(
      proposalAt("prop_pg00003", "rt_pg000001", 1, {benchAt(92.5, 3)}, ProposalDoor::ask));

  CHECK(second.error == ProposalMintError::none);
  CHECK(ask.error == ProposalMintError::none);
  const std::vector<ProposalHead> all =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(all.size(), static_cast<std::size_t>(3));
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(2));
  for (const ProposalHead& head : all)
    if (head.id == ProposalId{"prop_pg00001"}) {
      CHECK_EQ(head.state, ProposalState::superseded);
      CHECK_EQ(head.settledAtMs, std::optional<std::uint64_t>(kNow));
    }
}

// A replay reads back the proposal already waiting rather than superseding it with itself.
TEST(pg_gym_a_replayed_mint_reads_back_the_stored_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  const RoutineProposal minted = proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)});
  repo.insertProposal(minted);

  ProposalMintOutcome replayed = repo.insertProposal(minted);

  CHECK(replayed.error == ProposalMintError::none);
  CHECK_EQ(replayed.proposal, std::optional<RoutineProposal>(minted));
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));
}

// Every refusal the store alone can know, and each as a VALUE: an id spent by an account this
// caller cannot see, a routine it cannot read, and a line naming a movement it may not name — the
// last refused at the MINT so a proposal a lifter cannot apply never reaches their screen.
TEST(pg_gym_a_proposal_is_refused_for_a_spent_id_an_unknown_routine_and_an_unseen_movement) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgCatalogRepository catalog{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  catalog.insertExercise(wm::UserId{kOther},
                      Exercise{ExerciseId{"pg-their-zercher"}, "Their Zercher Squat",
                               Pattern::squat, Equipment::barbell, 2.5, true});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));

  ProposalMintOutcome spent =
      repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  ProposalMintOutcome theirs =
      repo.insertProposal(proposalAt("prop_pg00002", "rt_pg000009", 1, {benchAt(87.5, 3)}));
  ProposalMintOutcome unseen = repo.insertProposal(proposalAt(
      "prop_pg00003", "rt_pg000001", 1,
      {RoutineEntry{1, ExerciseId{"pg-their-zercher"}, 3, 8, 100.0, 180}}));

  CHECK(spent.error == ProposalMintError::idTaken);
  CHECK(theirs.error == ProposalMintError::unknownRoutine);
  CHECK(unseen.error == ProposalMintError::unknownExercise);
  // The refused mint rolled back whole: no header, no lines, and the connection is reusable at once.
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00003"}),
           std::optional<RoutineProposal>());
  CHECK(repo.insertProposal(proposalAt("prop_pg00004", "rt_pg000001", 1, {benchAt(87.5, 3)}))
            .error == ProposalMintError::none);
}

// A REFUSED MINT SPENDS NOTHING OF THE LIFTER'S, and it takes real SQL to prove it: the supersede
// that clears the pending slot runs INSIDE the mint's transaction, so a refusal reached after it
// would commit the settle and roll back nothing — the card would be gone off Today with nothing
// replacing it, behind a message reading "mint a different one and send it again". Proposal ids are
// client-minted and the key is global across accounts, so a deterministic minting scheme is all it
// takes to collide with a stranger.
TEST(pg_gym_a_refused_mint_leaves_the_pending_card_it_could_not_replace) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  ProposalMintOutcome stranger =
      repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000001", 1, {benchAt(90.0, 3)}));
  ProposalMintOutcome reused =
      repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(95.0, 3)}));

  CHECK(stranger.error == ProposalMintError::idTaken);
  CHECK(reused.error == ProposalMintError::idReused);
  // Neither refusal moved anything: the card the lifter can see is still waiting, and it is still
  // the diff that was minted for it.
  const std::vector<ProposalHead> waiting =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true});
  REQUIRE_EQ(waiting.size(), static_cast<std::size_t>(1));
  CHECK_EQ(waiting[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(waiting[0].state, ProposalState::pending);
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"})->changes[0].after,
           std::optional<EntryTargets>(EntryTargets{5, 3, 87.5, 180}));
  // And the stranger's own proposal is untouched by a refusal that named their id.
  CHECK_EQ(repo.proposalHeads(wm::UserId{kOther}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));
}

// The lifter's own hand, asked the one question that decides whether a card dies: did the document
// or the name actually move? A routine editor saving on close and a logger writing the whole
// document back to change one weight both land the bytes that already stand, and a drag up the
// routines screen moves only where the day sits — which no proposal is minted against, because an
// apply keeps the base's own position. None of the three destroyed a base, so none of them settles
// a proposal or moves the revision. A real edit still does both.
TEST(pg_gym_a_put_that_lands_the_same_document_moves_no_revision_and_settles_no_proposal) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  RoutineWriteOutcome identical =
      repo.replaceRoutine(routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}),
                          kNow + 60'000, std::nullopt);
  RoutineWriteOutcome dragged =
      repo.replaceRoutine(Routine{RoutineId{"rt_pg000001"}, wm::UserId{kUser}, "Push A", 3,
                                  {entryAt(1, "bench-press")}},
                          kNow + 60'000, std::nullopt);

  REQUIRE(identical.routine.has_value());
  REQUIRE(dragged.routine.has_value());
  CHECK_EQ(identical.routine->revision, 1);
  CHECK_EQ(dragged.routine->revision, 1);
  CHECK_EQ(dragged.routine->position, 3);
  CHECK_EQ(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).size(),
           static_cast<std::size_t>(1));

  RoutineWriteOutcome edited =
      repo.replaceRoutine(Routine{RoutineId{"rt_pg000001"}, wm::UserId{kUser}, "Push A", 3,
                                  {entryAt(1, "bench-press", 5, 5, 85.0)}},
                          kNow + 120'000, std::nullopt);

  REQUIRE(edited.routine.has_value());
  CHECK_EQ(edited.routine->revision, 2);
  CHECK_EQ(edited.routine->entries[0].targetWeightKg, std::optional<double>(85.0));
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, true}).empty());
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"})->head.state,
           ProposalState::superseded);
}

// THE TAP against real rows: one transaction, the whole document, the revision moved and the row
// dated. And the tap replayed reads back what it did rather than applying twice.
TEST(pg_gym_applying_a_proposal_writes_the_document_moves_the_revision_and_dates_the_record) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1,
                                 {benchAt(87.5, 3), entryAt(2, "back-squat", 3, 8, 100.0, 240)}));
  const Routine becomes =
      appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  ProposalSettleOutcome tapped =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 60'000);
  ProposalSettleOutcome again =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 120'000);

  CHECK(tapped.error == ProposalSettleError::none);
  REQUIRE(tapped.routine.has_value());
  CHECK_EQ(tapped.routine->revision, 2);
  REQUIRE_EQ(tapped.routine->entries.size(), static_cast<std::size_t>(2));
  CHECK_EQ(tapped.routine->entries[0].targetWeightKg, std::optional<double>(87.5));
  CHECK_EQ(tapped.routine->entries[1].exercise, ExerciseId{"back-squat"});
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  // The replayed tap is not a second write: the revision did not move again.
  CHECK(again.error == ProposalSettleError::none);
  CHECK_EQ(again.routine->revision, 2);
}

// The lifter's own PUT moves the revision and supersedes what was pending, in the SAME transaction —
// and the store refuses the apply under its own lock even when it is asked anyway.
TEST(pg_gym_the_lifters_own_write_supersedes_a_pending_proposal_and_the_tap_refuses) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  const Routine stale = appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                                  *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  RoutineWriteOutcome rewritten = repo.replaceRoutine(
      routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press", 5, 5, 85.0, 180)}),
      kNow + 60'000, std::nullopt);
  ProposalSettleOutcome refused =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, stale, kNow + 120'000);

  CHECK(rewritten.error == RoutineWriteError::none);
  CHECK_EQ(rewritten.routine->revision, 2);
  CHECK(refused.error == ProposalSettleError::superseded);
  CHECK_EQ(refused.routine, std::optional<Routine>());
  // The lifter's own numbers stand, and the proposal is a dated record rather than a row that went.
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"})->entries[0].targetWeightKg,
           std::optional<double>(85.0));
  const std::vector<ProposalHead> history =
      repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{RoutineId{"rt_pg000001"}, false});
  REQUIRE_EQ(history.size(), static_cast<std::size_t>(1));
  CHECK_EQ(history[0].state, ProposalState::superseded);
  CHECK_EQ(history[0].settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
}

// Dismissing changes nothing about the program and keeps the card; asking for the other decision is
// refused, and asking again for the same one replays.
TEST(pg_gym_dismissing_keeps_the_card_and_refuses_the_other_decision) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));
  const Routine becomes = appliedTo(*repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}),
                                    *repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}));

  ProposalSettleOutcome dismissed =
      repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 60'000);
  ProposalSettleOutcome again =
      repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 120'000);
  ProposalSettleOutcome tapped =
      repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow + 180'000);

  CHECK(dismissed.error == ProposalSettleError::none);
  CHECK_EQ(dismissed.proposal->head.state, ProposalState::dismissed);
  CHECK_EQ(dismissed.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK(again.error == ProposalSettleError::none);
  CHECK_EQ(again.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK(tapped.error == ProposalSettleError::settled);
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"})->revision, 1);
}

// §D14's *41 logged sets kept*, counted at READ time against the live log — the sentence that makes
// a removal safe to read has to be true when a lifter reads it.
TEST(pg_gym_a_removed_line_counts_the_sets_it_keeps_at_read_time) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  log.insertSession(sessionAt("ses_pg000001", 1'700'000'000'000));
  log.insertSet(benchSet("set_pg000001", 82.5, 1'700'000'060'000));
  log.insertSet(benchSet("set_pg000002", 82.5, 1'700'000'120'000));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {}));

  std::optional<RoutineProposal> read =
      repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"});

  REQUIRE(read.has_value());
  CHECK_EQ(read->head.intent, ProposalIntent::remove);
  REQUIRE_EQ(read->changes.size(), static_cast<std::size_t>(1));
  CHECK_EQ(read->changes[0].kind, ChangeKind::removed);
  CHECK_EQ(read->changes[0].loggedSets, 2);
}

// Applying a removal takes the day out of the program, and its proposals go with it — a day that
// has left has no editor to draw a History section in. The log keeps its frozen copy either way.
TEST(pg_gym_applying_a_removal_takes_the_routine_and_its_ledger_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {}));

  ProposalSettleOutcome tapped =
      repo.applyRemoval(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, kNow + 60'000);

  CHECK(tapped.error == ProposalSettleError::none);
  REQUIRE(tapped.proposal.has_value());
  CHECK_EQ(tapped.proposal->head.state, ProposalState::applied);
  CHECK_EQ(tapped.proposal->head.settledAtMs, std::optional<std::uint64_t>(kNow + 60'000));
  CHECK_EQ(tapped.routine, std::optional<Routine>());
  CHECK_EQ(repo.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}), std::optional<Routine>());
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
}

// Absent, another account's and never-existed are ONE answer on every proposal door, so a caller
// can never learn that an id exists by the shape of its refusal.
TEST(pg_gym_a_proposal_another_account_holds_resolves_to_nothing_on_every_door) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, Routine{RoutineId{"rt_pg000009"}, wm::UserId{kOther}, "Their plan", 0,
                             {entryAt(1, "bench-press")}});
  repo.insertProposal(proposalAt("prop_pg00009", "rt_pg000009", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::mcp, kOther));
  const Routine theirs = *repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000009"});

  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00009"}),
           std::optional<RoutineProposal>());
  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
  CHECK(repo.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, theirs, kNow).error ==
        ProposalSettleError::notFound);
  CHECK(repo.dismissProposal(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, kNow).error ==
        ProposalSettleError::notFound);
  CHECK(repo.applyRemoval(wm::UserId{kUser}, ProposalId{"prop_pg00009"}, kNow).error ==
        ProposalSettleError::notFound);
  // Their plan is exactly where it was.
  CHECK_EQ(repo.routine(wm::UserId{kOther}, RoutineId{"rt_pg000009"}),
           std::optional<Routine>(theirs));
}

// Deleting a routine by the lifter's own hand takes its ledger with it, the cascade the schema
// declares — so nothing is left pointing at a day of the program that is gone.
TEST(pg_gym_deleting_a_routine_takes_its_proposals_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgramRepository repo{wm::pgTestPool()};
  inserted(repo, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  repo.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)}));

  CHECK(repo.deleteRoutine(wm::UserId{kUser}, RoutineId{"rt_pg000001"}));

  CHECK(repo.proposalHeads(wm::UserId{kUser}, ProposalQuery{std::nullopt, false}).empty());
  CHECK_EQ(repo.proposal(wm::UserId{kUser}, ProposalId{"prop_pg00001"}),
           std::optional<RoutineProposal>());
}
