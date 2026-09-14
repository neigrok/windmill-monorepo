#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/application/AskService.h"
#include "test/platform/Fakes.h"

#include "test/products/gym/adapters/postgres/PgGymFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <future>
#include <optional>
#include <string>
#include <vector>

// Ask's threads against a real server.
using namespace wm::gym;
using namespace wm::gym::pgtest;

// The title is the first message VERBATIM, and a second ask into the same conversation does not rename it.
TEST(pg_gym_a_thread_is_titled_by_its_first_message_and_keeps_every_turn_as_sent) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  const std::string typed = "Bench \xE2\x80\x9Cstuck\xE2\x80\x9D at 82.5 \xE2\x80\x94 3 weeks, why?";

  openedAt(repo, "thr_pg000001", typed);
  said(repo, "thr_pg000001", typed, "Your top set has not moved.");
  // A second ask into the same conversation: the title is passed and ignored.
  openedAt(repo, "thr_pg000001", "something else entirely", kNow + 1'000);
  said(repo, "thr_pg000001", "and the squat?", "That one is moving.", kNow + 1'000);

  const std::optional<AskThread> held = repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  REQUIRE(held.has_value());
  CHECK_EQ(held->title, typed);
  CHECK_EQ(held->createdAtMs, kNow);
  CHECK_EQ(held->askedAtMs, kNow + 1'000);
  REQUIRE_EQ(held->turns.size(), 4u);
  CHECK_EQ(held->turns[0], (ThreadTurn{true, typed, kNow}));
  CHECK_EQ(held->turns[1], (ThreadTurn{false, "Your top set has not moved.", kNow}));
  CHECK_EQ(held->turns[2], (ThreadTurn{true, "and the squat?", kNow + 1'000}));
  CHECK_EQ(held->turns[3], (ThreadTurn{false, "That one is moving.", kNow + 1'000}));
}

// The id is a primary key across every account: one somebody else holds is refused, never appended to.
TEST(pg_gym_a_thread_id_another_account_holds_is_refused_and_their_words_stay_theirs) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "mine");
  said(repo, "thr_pg000001", "mine", "answered");

  const ThreadOpenOutcome theirs =
      repo.openThread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}, "yours", kNow);
  CHECK(theirs.error == ThreadOpenError::idTaken);
  CHECK_FALSE(theirs.thread.has_value());
  // …and the read gives them the same nothing an absent id would.
  CHECK_EQ(repo.thread(wm::UserId{kOther}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kOther}).empty());
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"})->turns.size(), 2u);
}

// A thread whose run never answered is taken back whole, but only while it holds no turns.
TEST(pg_gym_an_empty_thread_is_discarded_and_one_with_turns_is_not) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  openedAt(repo, "thr_pg000001", "never answered");
  openedAt(repo, "thr_pg000002", "answered once");
  said(repo, "thr_pg000002", "answered once", "here you go");

  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"});
  repo.discardEmptyThread(wm::UserId{kUser}, ThreadId{"thr_pg000002"});

  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  REQUIRE(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000002"}).has_value());
}

// The list: newest asked first, each row carrying the routine's name as it now stands.
TEST(pg_gym_the_thread_list_is_newest_first_and_carries_what_each_one_proposed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "older");
  said(repo, "thr_pg000001", "older", "answered");
  openedAt(repo, "thr_pg000002", "newer", kNow + 1'000);
  said(repo, "thr_pg000002", "newer", "answered", kNow + 1'000);
  program.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000002"}));

  const std::vector<AskThread> listed = repo.threads(wm::UserId{kUser});
  REQUIRE_EQ(listed.size(), 2u);
  CHECK_EQ(listed[0].id, ThreadId{"thr_pg000002"});
  CHECK_EQ(listed[1].id, ThreadId{"thr_pg000001"});
  // The list carries no turns — the titles and the outcomes are what a list prints.
  CHECK(listed[0].turns.empty());
  REQUIRE_EQ(listed[0].minted.size(), 1u);
  CHECK_EQ(listed[0].minted[0].id, ProposalId{"prop_pg00001"});
  CHECK_EQ(listed[0].minted[0].routineName, std::string("Push A"));
  CHECK(outcomeOf(listed[0]).kind == ThreadOutcomeKind::proposed);
  CHECK(listed[1].minted.empty());
  CHECK(outcomeOf(listed[1]).kind == ThreadOutcomeKind::readOnly);
}

// Deleting a conversation leaves the change it minted standing in the routine's history.
TEST(pg_gym_deleting_a_thread_leaves_the_change_it_applied_in_the_routines_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  PgProgramRepository program{wm::pgTestPool()};
  inserted(program, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?");
  said(repo, "thr_pg000001", "Bench has been stuck at 82.5 for three weeks. What do you see?",
       "Try heavier triples.");
  program.insertProposal(proposalAt("prop_pg00001", "rt_pg000001", 1, {benchAt(87.5, 3)},
                                 ProposalDoor::ask, kUser, ThreadId{"thr_pg000001"}));
  const Routine becomes = routineAt("rt_pg000001", "Push A", {benchAt(87.5, 3)});
  REQUIRE(program.applyRevision(wm::UserId{kUser}, ProposalId{"prop_pg00001"}, becomes, kNow).error ==
          ProposalSettleError::none);

  CHECK(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));

  // The conversation is gone, turns and all.
  CHECK_EQ(repo.thread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}), std::optional<AskThread>());
  CHECK(repo.threads(wm::UserId{kUser}).empty());
  const std::vector<RoutineEvent> history =
      program.routineHistory(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE_EQ(history.size(), 2u);
  CHECK(history[0].kind == RoutineEventKind::proposal);
  REQUIRE(history[0].proposal.has_value());
  CHECK(history[0].proposal->state == ProposalState::applied);
  CHECK_EQ(history[0].proposal->changes, 1);
  CHECK(history[0].proposal->source.door == ProposalDoor::ask);
  CHECK_FALSE(history[0].proposal->source.thread.has_value());
  const std::optional<Routine> standing = program.routine(wm::UserId{kUser}, RoutineId{"rt_pg000001"});
  REQUIRE(standing.has_value());
  CHECK_EQ(standing->entries, std::vector<RoutineEntry>{benchAt(87.5, 3)});
  // Deleting it twice is not a second deletion, and another account's is nobody's.
  CHECK_FALSE(repo.deleteThread(wm::UserId{kUser}, ThreadId{"thr_pg000001"}));
}

TEST(pg_coach_evidence_survives_corrections_renames_and_deletion_of_its_source) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository threads{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  fake::FakeGym other;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  wm::fake::FakeSubscriptionRepository subscriptions;
  wm::fake::FakeAiUsageRepository usage;
  wm::Entitlements entitlements{subscriptions, usage};
  TrainingService training{log, other.program, clock, tokens};
  CatalogService catalog{other.catalog};
  ProgramService program{other.program, clock};
  NotesService notes{other.notes, clock};
  BodyweightService bodyweight{other.bodyweight};
  ThreadService conversations{threads, clock};
  GymTools tools{training, catalog, program, notes, bodyweight, "https://windmill.works"};
  fake::FakeAsk agent;
  AskService ask{training, conversations, agent, tools, entitlements};
  const wm::UserId owner{kUser};
  const ThreadId thread{"thr_evidence1"};
  const Session session{SessionId{"ses_evidence1"}, owner, kNow - 9000, kNow,
                        std::nullopt, PlanSnapshot{"Push A", {}}};
  Session open = session;
  open.finishedAtMs.reset();
  log.insertSession(open);
  REQUIRE(log.insertSet(benchSet("set_evidence1", 80, kNow - 1000, session.id.str())).set.has_value());
  log.close(session.id, *session.finishedAtMs, ClosedBy::finish);
  agent.plan = {{"list_sessions", wm::parse("{}")},
      {"get_session", wm::parse(R"({"sessionId":"ses_evidence1"})")}};
  std::promise<AskReply> settled;
  auto future = settled.get_future();
  ask.ask(owner, "gym-pgtest@example.com", thread, "What did I train?",
      [&settled](AskReply reply) { settled.set_value(std::move(reply)); });
  const AskReply live = future.get();
  REQUIRE(live.answer.ok);
  REQUIRE(live.receipt.has_value());
  const AnswerReceipt expected{1, {1, 1, 1}, {{"list_sessions", false}, {"get_session", false}}, {},
      {{"list_sessions", session, ReadCoverage::summary, 0, WorkoutObservation{session, 1, 640}},
       {"get_session", session, ReadCoverage::session, 1, WorkoutObservation{session, 1, 640}}}};
  CHECK_EQ(*live.receipt, expected);
  const AskThread before = *threads.thread(owner, thread);
  REQUIRE_EQ(before.turns.size(), 2u);
  CHECK_EQ(before.turns[1].receipt, std::optional<AnswerReceipt>{expected});
  CHECK_FALSE(before.turns[0].receipt.has_value());
  CHECK_EQ(before.askedAtMs, before.turns[0].atMs);
  CHECK_EQ(before.askedAtMs, before.turns[1].atMs);

  Set fixed = *log.setOf(owner, SetId{"set_evidence1"});
  fixed.weightKg = 120;
  REQUIRE(log.updateSet(owner, fixed).has_value());
  {
    wm::PgLease connection{*wm::pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("UPDATE gym_sessions SET plan = jsonb_set(plan, '{routine}', '\"Renamed\"') "
             "WHERE id = 'ses_evidence1'");
    txn.commit();
  }
  CHECK_EQ(log.session(owner, session.id)->plan->routineName, std::string("Renamed"));
  CHECK_EQ(threads.thread(owner, thread), std::optional<AskThread>{before});
  REQUIRE(log.deleteSession(owner, session.id));
  CHECK_EQ(threads.thread(owner, thread), std::optional<AskThread>{before});
  CHECK_FALSE(threads.thread(wm::UserId{kOther}, thread).has_value());
  CHECK_EQ(threads.thread(wm::UserId{kOther}, thread),
           threads.thread(wm::UserId{kOther}, ThreadId{"thr_absent01"}));
  threads.appendTurns(wm::UserId{kOther}, thread, {{false, "not mine", kNow + 1000, expected}});
  CHECK_EQ(threads.thread(owner, thread), std::optional<AskThread>{before});
  agent.answers = false;
  std::promise<AskReply> failed;
  auto failure = failed.get_future();
  ask.ask(owner, "gym-pgtest@example.com", thread, "Again?",
      [&failed](AskReply reply) { failed.set_value(std::move(reply)); });
  const AskReply noAnswer = failure.get();
  CHECK_FALSE(noAnswer.answer.ok);
  CHECK_FALSE(noAnswer.receipt.has_value());
  CHECK_EQ(threads.thread(owner, thread), std::optional<AskThread>{before});
}

TEST(pg_coach_receipts_are_nullable_for_old_turns_and_never_attach_to_lifter_turns) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  const wm::UserId owner{kUser};
  const ThreadId thread{"thr_evidence1"};
  openedAt(repo, thread.str(), "First");
  said(repo, thread.str(), "First", "Old answer");
  repo.appendTurns(owner, thread, {{true, "Again", kNow + 1000, AnswerReceipt{}},
                                  {false, "New answer", kNow + 1000, AnswerReceipt{}}});
  const AskThread held = *repo.thread(owner, thread);
  CHECK_EQ(held.turns, (std::vector<ThreadTurn>{{true, "First", kNow},
      {false, "Old answer", kNow}, {true, "Again", kNow + 1000},
      {false, "New answer", kNow + 1000, AnswerReceipt{}}}));
  const Json::Value wire = toJson(held);
  CHECK_FALSE(wire["turns"][0].isMember("receipt"));
  CHECK_FALSE(wire["turns"][1].isMember("receipt"));
  CHECK_FALSE(wire["turns"][2].isMember("receipt"));
  CHECK_EQ(wire["turns"][3]["receipt"], wm::parse(R"({"version":1,"read":{"sets":0,"sessions":0,"weeks":0},
      "steps":[],"proposals":[],"observations":[]})"));
}

TEST(pg_coach_question_answer_receipt_and_asked_time_roll_back_together) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository repo{wm::pgTestPool()};
  const wm::UserId owner{kUser};
  const ThreadId thread{"thr_evidence1"};
  openedAt(repo, thread.str(), "First");
  const AskThread before = *repo.thread(owner, thread);
  bool refused = false;
  try {
    repo.appendTurns(owner, thread, {{true, "Question inserted first", kNow + 1000},
        {false, std::string(1, static_cast<char>(0xff)), kNow + 1000, AnswerReceipt{}}});
  } catch (const pqxx::sql_error&) {
    refused = true;
  }
  CHECK(refused);
  CHECK_EQ(repo.thread(owner, thread), std::optional<AskThread>{before});
  repo.appendTurns(owner, thread, {{true, "Retry", kNow + 2000},
                                 {false, "Answer", kNow + 2000, AnswerReceipt{}}});
  const AskThread after = *repo.thread(owner, thread);
  CHECK_EQ(after.askedAtMs, kNow + 2000);
  CHECK_EQ(after.turns, (std::vector<ThreadTurn>{{true, "Retry", kNow + 2000},
      {false, "Answer", kNow + 2000, AnswerReceipt{}}}));
}

TEST(pg_coach_removal_keeps_evidence_and_marks_missing_decisions_unknown_in_detail_and_history) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository threads{wm::pgTestPool()};
  PgProgramRepository routines{wm::pgTestPool()};
  PgLogRepository log{wm::pgTestPool()};
  fake::FakeGym other;
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  wm::fake::FakeSubscriptionRepository subscriptions;
  wm::fake::FakeAiUsageRepository usage;
  wm::Entitlements entitlements{subscriptions, usage};
  TrainingService training{log, routines, clock, tokens};
  CatalogService catalog{other.catalog};
  ProgramService program{routines, clock};
  NotesService notes{other.notes, clock};
  BodyweightService bodyweight{other.bodyweight};
  ThreadService conversations{threads, clock};
  GymTools tools{training, catalog, program, notes, bodyweight, "https://windmill.works"};
  fake::FakeAsk agent;
  AskService ask{training, conversations, agent, tools, entitlements};
  const wm::UserId owner{kUser};
  const ThreadId thread{"thr_removal01"};
  inserted(routines, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  inserted(routines, routineAt("rt_pg000002", "Push B", {entryAt(1, "bench-press")}));
  const Session session{SessionId{"ses_removal01"}, owner, kNow - 9000, std::nullopt,
                        RoutineId{"rt_pg000001"}, pushA()};
  log.insertSession(session);
  REQUIRE(log.insertSet(benchSet("set_removal01", 80, kNow - 1000, session.id.str())).set.has_value());
  log.close(session.id, kNow, ClosedBy::finish);
  const auto performed = log.setsOf(session.id);
  agent.plan = {{"get_session", wm::parse(R"({"sessionId":"ses_removal01"})")},
      {"propose_routine_removal", wm::parse(R"({"id":"prop_removal01","routineId":"rt_pg000001",
        "summary":"Remove this routine."})")}};
  std::promise<AskReply> removal;
  auto firstReply = removal.get_future();
  ask.ask(owner, "gym-pgtest@example.com", thread, "Remove Push A?",
      [&removal](AskReply reply) { removal.set_value(std::move(reply)); });
  const AskReply first = firstReply.get();
  REQUIRE(first.answer.ok);
  REQUIRE(first.receipt.has_value());
  CHECK_EQ(first.receipt->proposals, (std::vector<std::string>{"prop_removal01"}));
  CHECK_EQ(outcomeOf(*threads.thread(owner, thread)),
           (ThreadOutcome{ThreadOutcomeKind::proposed, 1, RoutineId{"rt_pg000001"}, "Push A"}));

  agent.plan = {{"propose_routine_change", wm::parse(R"({"id":"prop_removal02","routineId":"rt_pg000002",
      "summary":"Try triples.","entries":[{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":85}]}]})")}};
  std::promise<AskReply> revision;
  auto secondReply = revision.get_future();
  ask.ask(owner, "gym-pgtest@example.com", thread, "And revise Push B?",
      [&revision](AskReply reply) { revision.set_value(std::move(reply)); });
  REQUIRE(secondReply.get().answer.ok);
  const AskThread before = *threads.thread(owner, thread);
  REQUIRE_EQ(before.minted.size(), 2u);
  CHECK_EQ(before.referencedProposals,
           (std::vector<ProposalId>{ProposalId{"prop_removal01"}, ProposalId{"prop_removal02"}}));

  REQUIRE(program.apply(owner, ProposalId{"prop_removal01"}).error == ProposalSettleError::none);
  CHECK_FALSE(program.proposal(owner, ProposalId{"prop_removal01"}).has_value());
  const AskThread detail = *threads.thread(owner, thread);
  const std::vector<AskThread> listed = threads.threads(owner);
  REQUIRE_EQ(listed.size(), 1u);
  CHECK_EQ(detail.turns, before.turns);
  CHECK_EQ(detail.referencedProposals, before.referencedProposals);
  CHECK_EQ(detail.minted, (std::vector<ThreadProposal>{before.minted[1]}));
  AskThread summary = detail;
  summary.turns.clear();
  CHECK_EQ(listed[0], summary);
  CHECK_EQ(outcomeOf(detail), (ThreadOutcome{ThreadOutcomeKind::unknown, 0, std::nullopt, ""}));
  CHECK_EQ(toJson(detail)["outcome"], wm::parse(R"({"kind":"unknown","changes":0})"));
  CHECK_EQ(toJson(listed[0])["outcome"], wm::parse(R"({"kind":"unknown","changes":0})"));
  CHECK_EQ(toJson(detail)["proposals"][0], toJson(before)["proposals"][1]);
  CHECK_EQ(log.setsOf(session.id), performed);
  REQUIRE(log.session(owner, session.id).has_value());
  CHECK_EQ(log.session(owner, session.id)->plan, session.plan);
  CHECK_FALSE(log.session(owner, session.id)->routine.has_value());
  CHECK_FALSE(threads.thread(wm::UserId{kOther}, thread).has_value());
  CHECK(threads.threads(wm::UserId{kOther}).empty());

  REQUIRE(program.deleteRoutine(owner, RoutineId{"rt_pg000002"}));
  const AskThread gone = *threads.thread(owner, thread);
  CHECK(gone.minted.empty());
  CHECK_EQ(gone.turns, before.turns);
  CHECK_EQ(gone.referencedProposals, before.referencedProposals);
  CHECK_EQ(outcomeOf(gone), (ThreadOutcome{ThreadOutcomeKind::unknown, 0, std::nullopt, ""}));
  CHECK_EQ(outcomeOf(threads.threads(owner)[0]), outcomeOf(gone));
}

TEST(pg_coach_thread_reference_projection_preserves_duplicates_and_ignores_old_and_lifter_turns) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository threads{wm::pgTestPool()};
  const wm::UserId owner{kUser};
  const ThreadId thread{"thr_reference01"};
  openedAt(threads, thread.str(), "Old question");
  said(threads, thread.str(), "Old question", "Old answer");
  AnswerReceipt lifter;
  lifter.proposals = {"prop_notowned"};
  AnswerReceipt first;
  first.proposals = {"prop_second01", "prop_first001", "prop_second01"};
  AnswerReceipt second;
  second.proposals = {"prop_first001"};
  threads.appendTurns(owner, thread, {{true, "Question", kNow, lifter},
      {false, "First", kNow, first}, {true, "Follow-up", kNow}, {false, "Second", kNow, second}});
  const auto detail = threads.thread(owner, thread);
  REQUIRE(detail.has_value());
  const std::vector<ProposalId> expected{ProposalId{"prop_second01"}, ProposalId{"prop_first001"},
                                       ProposalId{"prop_second01"}, ProposalId{"prop_first001"}};
  CHECK_EQ(detail->referencedProposals, expected);
  CHECK_EQ(threads.threads(owner)[0].referencedProposals, expected);
  CHECK_FALSE(detail->turns[2].receipt.has_value());
  CHECK_EQ(outcomeOf(*detail), (ThreadOutcome{ThreadOutcomeKind::unknown, 0, std::nullopt, ""}));
}

TEST(pg_coach_history_ignores_malformed_receipts_without_changing_valid_evidence_or_stored_rows) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAskThreadRepository threads{wm::pgTestPool()};
  PgProgramRepository routines{wm::pgTestPool()};
  const wm::UserId owner{kUser};
  const ThreadId validThread{"thr_valid0001"};
  const ThreadId invalidThread{"thr_invalid01"};
  inserted(routines, routineAt("rt_pg000001", "Push A", {entryAt(1, "bench-press")}));
  openedAt(threads, validThread.str(), "Valid answer");
  routines.insertProposal(proposalAt("prop_valid001", "rt_pg000001", 1, {benchAt(87.5, 3)},
      ProposalDoor::ask, kUser, validThread));
  AnswerReceipt accepted;
  accepted.proposals = {"prop_valid001"};
  threads.appendTurns(owner, validThread, {{true, "Valid answer", kNow},
      {false, "A proposal", kNow, accepted}});
  const AskThread valid = *threads.thread(owner, validThread);
  openedAt(threads, invalidThread.str(), "Stored evidence");
  said(threads, invalidThread.str(), "Stored evidence", "Answer text stays");
  const AskThread withoutReceipt = *threads.thread(owner, invalidThread);
  AnswerReceipt unavailable;
  unavailable.proposals = {"prop_missing1"};
  const Json::Value base = toJson(unavailable);
  std::vector<Json::Value> malformed{Json::Value(), Json::Value("scalar"),
      Json::Value(42), Json::Value(true), Json::Value(Json::arrayValue), Json::Value(Json::objectValue)};
  for (const Json::Value& proposals : {wm::parse("null"), wm::parse("42"), wm::parse("\"prop_missing1\""),
      wm::parse("{}"), wm::parse("[\"prop_missing1\",null]"), wm::parse("[42]"),
      wm::parse("[{}]"), wm::parse("[true]")}) {
    Json::Value receipt = base;
    receipt["proposals"] = proposals;
    malformed.push_back(std::move(receipt));
  }
  Json::Value unsupported = base;
  unsupported["version"] = 2;
  malformed.push_back(unsupported);
  Json::Value incomplete = base;
  incomplete["read"].removeMember("sets");
  malformed.push_back(incomplete);
  Json::Value badObservation = base;
  badObservation["observations"].append(wm::parse(R"({"tool":"last_time","sessionId":"ses_invalid01",
      "startedAt":1000,"coverage":"movement","exerciseId":"bench-press","setsRead":1,
      "workout":{"workingSetCount":1,"tonnageKg":400}})"));
  malformed.push_back(badObservation);
  Json::Value badStep = base;
  badStep["steps"].append(wm::parse(R"({"tool":"get_session","failed":"false"})"));
  malformed.push_back(badStep);

  for (const Json::Value& receipt : malformed) {
    {
      wm::PgLease connection{*wm::pgTestPool()};
      pqxx::work txn{*connection};
      txn.exec_params("UPDATE gym_ask_turns SET receipt = $1::jsonb WHERE thread_id = $2 AND NOT from_lifter",
                      wm::dump(receipt), invalidThread.str());
      txn.commit();
    }
    CHECK_EQ(threads.thread(owner, invalidThread), std::optional<AskThread>{withoutReceipt});
    CHECK_EQ(threads.thread(owner, validThread), std::optional<AskThread>{valid});
    const auto listed = threads.threads(owner);
    REQUIRE_EQ(listed.size(), 2u);
    for (const AskThread& row : listed) {
      AskThread expected = row.id == validThread ? valid : withoutReceipt;
      expected.turns.clear();
      CHECK_EQ(row, expected);
      CHECK_EQ(outcomeOf(row), row.id == validThread
          ? (ThreadOutcome{ThreadOutcomeKind::proposed, 1, RoutineId{"rt_pg000001"}, "Push A"})
          : (ThreadOutcome{ThreadOutcomeKind::readOnly, 0, std::nullopt, ""}));
    }
    wm::PgLease connection{*wm::pgTestPool()};
    pqxx::work txn{*connection};
    const auto stored = txn.exec_params("SELECT receipt::text FROM gym_ask_turns WHERE thread_id = $1 AND NOT from_lifter",
                                        invalidThread.str());
    CHECK_EQ(wm::dump(wm::parse(stored[0]["receipt"].as<std::string>())), wm::dump(receipt));
  }
  threads.appendTurns(owner, invalidThread, {{true, "Valid follow-up", kNow + 1000},
      {false, "Accepted evidence", kNow + 1000, unavailable}});
  const AskThread recovered = *threads.thread(owner, invalidThread);
  CHECK_EQ(recovered.referencedProposals, (std::vector<ProposalId>{ProposalId{"prop_missing1"}}));
  CHECK_FALSE(recovered.turns[1].receipt.has_value());
  CHECK_EQ(recovered.turns[3].receipt, std::optional<AnswerReceipt>{unavailable});
  CHECK_EQ(outcomeOf(recovered), (ThreadOutcome{ThreadOutcomeKind::unknown, 0, std::nullopt, ""}));
  CHECK(threads.threads(wm::UserId{kOther}).empty());
}
