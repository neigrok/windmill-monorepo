#include "platform/application/sync/Admission.h"

#include "platform/application/WorkerPool.h"
#include "platform/application/WriteObservation.h"
#include "platform/application/sync/ServerCall.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Wire.h"

#include "test/platform/Fakes.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <chrono>
#include <atomic>
#include <future>
#include <string>
#include <typeinfo>
#include <variant>
#include <vector>

// What the golden corpus does not pin about Admission: the text merge's work bound below MERGE_WORK_CELLS, a base
// rev that is a double past the safe integers, a string holding U+0000, a replica binding a push's 409 took away or
// another account holds by the time its intent is admitted, a fault in step R's own write, and the server's
// physical clock.

using namespace wm;
using namespace wm::sync;

namespace {

struct WriteCapture {
  std::vector<WriteCompletion> completed;
  WriteCapture() { installWriteSink([this](const WriteCompletion& write) { completed.push_back(write); }); }
  ~WriteCapture() { installWriteSink({}); }
};

// A's overlay of tree b_00000001 with mark oak's memo "red blue" at rev 1, and A's replica bound at n 0.
Json::Value markedOverlay() {
  return parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}, "B": {"name": "Bob"}},
      "scopes": {
        "acct:A/overlay/b_00000001": {"kind": "overlay", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "e20fc4bfe5b8860ea5b055a09220f94960b480fa341720dda2ea44dd4e50b84d", "governedBy": "tree:b_00000001"},
        "acct:A/probe": {"kind": "product", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "ebc41c27fd23cc61823a43f3362722bf92a6ffea3191e96d1f20cf4b42c3e9e8"},
        "tree:b_00000001": {"kind": "tree", "owner": "A", "state": "alive", "seq": 1, "counters": {},
            "digest": "34cfa50c64a4ac819036783f44030d4905a8d034c662757d08ef0a00e7eb3d1a", "governedBy": "acct:A/probe#board#b_00000001"}},
      "rows": {
        "acct:A/overlay/b_00000001": [{"t": "mark", "id": "oak", "x": {"memo": {"text": "red blue", "rev": 1, "merged": false}},
            "seq": 1, "rc": 1000, "ru": 1000}],
        "acct:A/probe": [{"t": "board", "id": "b_00000001", "life": ["alive", "2000:0:r_aaaaaaaaaaaa"], "born": "2000:0:r_aaaaaaaaaaaa",
            "seq": 1, "rc": 1000, "ru": 1000}],
        "tree:b_00000001": [{"t": "tag", "id": "oak", "life": ["alive", "2100:0:r_aaaaaaaaaaaa"], "born": "2100:0:r_aaaaaaaaaaaa",
            "seq": 1, "rc": 1000, "ru": 1000}]},
      "replicas": {"rp_0000000000000000000000000000000a": {"account": "A", "lastN": 0}}})");
}

TEST(every_registered_sync_command_logs_one_bounded_command_and_admission_outcome) {
  BlockingThread::Mark blocking;
  for (int product = 0; product != 3; ++product) {
    test::FakeWorld world(product == 1, product == 2);
    Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
    for (const CommandDef& command : world.catalog().registry().commands()) {
      WriteCapture capture;
      Json::Value intent(Json::objectValue);
      intent["scope"] = "self/" + command.scope.product;
      intent["cmd"]["name"] = command.name;
      intent["cmd"]["args"]["private_content"] = "PRIVATE-JOURNAL-WORKOUT-TOKEN";
      const auto outcome = admission.admit(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000);
      REQUIRE(std::holds_alternative<Admitted>(outcome));
      CHECK_EQ(jcs(std::get<Admitted>(outcome).result), R"({"code":"invalid","s":"refused"})");
      REQUIRE_EQ(capture.completed.size(), 2u);
      const auto& observed = capture.completed[0];
      CHECK_EQ(observed.operation, "sync.command." + command.name);
      CHECK_EQ(observed.product, command.scope.product);
      CHECK_EQ(observed.door, "command");
      CHECK_EQ(observed.outcome, "invalid");
      CHECK(observed.durationMs >= 0);
      CHECK_FALSE(observed.requestId.empty());
      CHECK_EQ(capture.completed[1].operation, "sync.admit");
      CHECK_EQ(capture.completed[1].product, command.scope.product);
      CHECK_EQ(capture.completed[1].door, "server-origin");
      CHECK_EQ(capture.completed[1].outcome, "invalid");
      CHECK_EQ(capture.completed[1].requestId, observed.requestId);
      CHECK_EQ(world.catalog().commandOperation(command.name), observed.operation);
      CHECK(world.failures.reports.empty());
    }
  }
}

TEST(sync_observability_bounds_unknown_operations_products_and_refusal_codes) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  WriteCapture capture;
  auto intent = parseJson(R"({"scope":"self/PRIVATE-TOKEN","cmd":{"name":"PRIVATE-JOURNAL","args":{}}})");
  const auto outcome = admission.admit(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000);
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  REQUIRE_EQ(capture.completed.size(), 2u);
  CHECK_EQ(capture.completed[0].operation, "sync.command.unknown");
  CHECK_EQ(capture.completed[0].product, "platform");
  CHECK_EQ(capture.completed[0].outcome, "invalid");
  CHECK_EQ(capture.completed[1].operation, "sync.admit");
  CHECK_EQ(capture.completed[1].product, "platform");
  CHECK_EQ(capture.completed[1].outcome, "invalid");
  CHECK_EQ(world.catalog().observationOutcome(parseJson(R"({"s":"refused","code":"PRIVATE-EXCEPTION"})")), "failed");
  CHECK(world.failures.reports.empty());
}

TEST(sync_invariant_failures_report_static_operation_type_and_request_id_without_messages) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  struct InvariantFailure final : SyncCommand {
    bool isReplay(CommandCtx&) override { return false; }
    CommandOutcome run(CommandCtx&) override { throw std::logic_error("PRIVATE-JOURNAL-TOKEN-EMAIL"); }
  } command;
  SyncCatalog catalog(world.catalog().registry());
  for (const TypeDef& type : catalog.registry().types()) catalog.bindType(world.catalog().store(type.name));
  for (const CommandDef& def : catalog.registry().commands()) catalog.bindCommand(def.name, command);
  catalog.seal();
  Admission admission(catalog, world.store(), world.feed, world.clock(), world.failures);
  WriteCapture capture;
  const auto intent = parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.tick","args":{}}})");
  WriteContext request("internal-request-1");
  const auto outcome = admission.admit(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000);
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), R"({"code":"internal","s":"refused"})");
  REQUIRE_EQ(world.failures.reports.size(), 1u);
  const auto& report = world.failures.reports.front();
  CHECK(report.find("sync.command.probe.tick") != std::string::npos);
  CHECK(report.find(typeid(std::logic_error).name()) != std::string::npos);
  CHECK(report.find("internal-request-1") != std::string::npos);
  CHECK(report.find("PRIVATE") == std::string::npos);
  REQUIRE_EQ(capture.completed.size(), 2u);
  CHECK_EQ(capture.completed[0].operation, "sync.command.probe.tick");
  CHECK_EQ(capture.completed[0].outcome, "failed");
  CHECK_EQ(capture.completed[1].operation, "sync.admit");
  CHECK_EQ(capture.completed[1].outcome, "failed");
  CHECK_EQ(capture.completed[0].requestId, "internal-request-1");
  CHECK_EQ(capture.completed[1].requestId, "internal-request-1");
}

TEST(sync_server_builder_refusals_preserve_the_original_exception_and_report_no_issue) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  WriteCapture capture;
  const auto intent = parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.tick","args":{}}})");
  bool refused = false;
  try {
    admission.admitBuilt(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000,
        [](SyncTxn&) -> std::optional<Json::Value> {
          throw ServerBuildAborted{std::make_exception_ptr(std::invalid_argument("PRIVATE-CONTENT")), "cap"};
        });
  } catch (const std::invalid_argument& error) {
    refused = std::string(error.what()) == "PRIVATE-CONTENT";
  }
  CHECK(refused);
  CHECK(world.failures.reports.empty());
  REQUIRE_EQ(capture.completed.size(), 1u);
  CHECK_EQ(capture.completed[0].operation, "sync.admit");
  CHECK_EQ(capture.completed[0].outcome, "cap");
}

TEST(sync_builder_logs_the_built_command_at_commit_instead_of_its_scope_placeholder) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  WriteCapture capture;
  const auto placeholder = parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.tick","args":{}}})");
  const auto built = parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.start","args":{"id":"run00001","label":"PRIVATE","startedAt":1000000,"join":false}}})");
  const auto outcome = admission.admitBuilt(ServerOrigin{world.account("A"), std::nullopt}, placeholder, 1'000'000,
      [&](SyncTxn&) -> std::optional<Json::Value> { return built; });
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(std::get<Admitted>(outcome).result["s"].asString(), "ok");
  REQUIRE_EQ(capture.completed.size(), 3u);
  CHECK_EQ(capture.completed[0].operation, "sync.publish");
  CHECK_EQ(capture.completed[0].outcome, "ok");
  CHECK_EQ(capture.completed[1].operation, "sync.command.probe.start");
  CHECK_EQ(capture.completed[1].product, "probe");
  CHECK_EQ(capture.completed[1].door, "command");
  CHECK_EQ(capture.completed[1].outcome, "ok");
  CHECK_EQ(capture.completed[2].operation, "sync.admit");
  CHECK_EQ(capture.completed[2].outcome, "ok");
  CHECK_EQ(capture.completed[0].requestId, capture.completed[1].requestId);
  CHECK_EQ(capture.completed[1].requestId, capture.completed[2].requestId);
  CHECK(world.failures.reports.empty());
}

TEST(sync_scope_cursor_reset_logs_bounded_product_and_outcome_without_cursor_content) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  WriteCapture capture;
  const auto reply = service.pull(Credential::sent(world.account("A")),
      R"({"scopes":[{"scope":"self/probe","cursor":"PRIVATE-CURSOR-TOKEN"}]})");
  CHECK_EQ(reply.status, 200);
  CHECK_EQ(reply.body["pages"][0]["kind"].asString(), "reset");
  REQUIRE_EQ(capture.completed.size(), 1u);
  CHECK_EQ(capture.completed[0].operation, "sync.scope.pull");
  CHECK_EQ(capture.completed[0].product, "probe");
  CHECK_EQ(capture.completed[0].door, "sync");
  CHECK_EQ(capture.completed[0].outcome, "reset");
  CHECK(world.failures.reports.empty());
}

TEST(sync_replica_replay_digest_mismatch_logs_without_intent_content_or_replica_id) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  wm::fake::FakeClock clock;
  clock.now = 1'000'000;
  SyncService service(world.catalog(), world.store(), admission, clock);
  TimeBudget budget(60'000);
  auto push = parseJson(R"({"replica":"rp_0000000000000000000000000000000a","account":"A","ackThrough":0,"intents":[{"n":1,"scope":"self/probe","d":[{"t":"card","id":"card0001","born":"2000:0:r_aaaaaaaaaaaa","life":["alive","2000:0:r_aaaaaaaaaaaa"],"f":{"title":["One","2000:0:r_aaaaaaaaaaaa"]}}]}]})");
  const auto first = service.push(Credential::sent(world.account("A")), jcs(push), budget);
  CHECK_EQ(first.body["results"][0]["s"].asString(), "ok");
  push["intents"][0]["d"][0]["f"]["title"][0] = "PRIVATE";
  WriteCapture capture;
  const auto forked = service.push(Credential::sent(world.account("A")), jcs(push), budget);
  CHECK_EQ(forked.status, 409);
  CHECK_EQ(forked.body["error"].asString(), "replica-forked");
  REQUIRE_EQ(capture.completed.size(), 1u);
  CHECK_EQ(capture.completed[0].operation, "sync.intent.digest");
  CHECK_EQ(capture.completed[0].product, "probe");
  CHECK_EQ(capture.completed[0].door, "sync");
  CHECK_EQ(capture.completed[0].outcome, "replica-forked");
  CHECK(capture.completed[0].requestId != push["replica"].asString());
  CHECK(world.failures.reports.empty());
}

TEST(sync_call_replay_digest_mismatch_logs_without_call_arguments_or_user_request_id) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const auto intent = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["One",null]}}]})");
  ServerCall original(admission, world.store(), world.account("A"), "PRIVATE-REQUEST-ID", "cards.add", {}, "probe");
  const auto first = original.admit(intent, 1'000'000);
  REQUIRE(std::holds_alternative<Admitted>(first));
  WriteCapture capture;
  ServerCall changed(admission, world.store(), world.account("A"), "PRIVATE-REQUEST-ID", "cards.add", Json::Value("PRIVATE-ARGUMENTS"), "probe");
  const auto conflicting = changed.admit(intent, 1'000'000);
  REQUIRE(std::holds_alternative<CallAnswered>(conflicting));
  CHECK_EQ(std::get<CallAnswered>(conflicting).result["code"].asString(), "request-conflict");
  REQUIRE_EQ(capture.completed.size(), 2u);
  CHECK_EQ(capture.completed[0].operation, "sync.call.digest");
  CHECK_EQ(capture.completed[0].product, "probe");
  CHECK_EQ(capture.completed[0].door, "server-origin");
  CHECK_EQ(capture.completed[0].outcome, "request-conflict");
  CHECK_EQ(capture.completed[1].operation, "sync.admit");
  CHECK_EQ(capture.completed[1].outcome, "request-conflict");
  CHECK(capture.completed[0].requestId != "PRIVATE-REQUEST-ID");
  CHECK_EQ(capture.completed[0].requestId, capture.completed[1].requestId);
  CHECK(world.failures.reports.empty());
}

// Mark oak's memo write in A's overlay.
Json::Value memoIntent(const Json::Value& write) {
  Json::Value intent = parseJson(R"({"scope": "self/overlay/b_00000001", "d": [{"t": "mark", "id": "oak", "x": {}}]})");
  intent["d"][0]["x"]["memo"] = write;
  return intent;
}

// Intent 1 of A's replica, admitted at serverNow 1000000.
AdmitOutcome admitFirst(test::SyncWorld& world, Admission& admission, const Json::Value& intent) {
  return admission.admit(ReplicaOrigin{world.account("A"), "rp_0000000000000000000000000000000a", 1, intentDigest(intent)}, intent,
                         1'000'000);
}

// The seeded state with intent 1 answered `result` and nothing else changed.
Json::Value answeredOnly(const Json::Value& seeded, const Json::Value& intent, const Json::Value& result) {
  Json::Value expected = seeded;
  expected["replicas"]["rp_0000000000000000000000000000000a"]["lastN"] = 1;
  Json::Value stored(Json::objectValue);
  stored["n"] = 1;
  stored["digest"] = intentDigest(intent).hex();
  stored["result"] = result;
  stored["faults"] = 0;
  expected["results"]["rp_0000000000000000000000000000000a"].append(stored);
  return expected;
}

}

TEST(admission_doors_share_the_scope_mutex_until_commit_publication_finishes) {
  test::FakeWorld world;
  struct HeldPublication final : ChangeFeed {
    std::promise<void> committed;
    std::promise<void> release;
    void publish(const CommittedChange&) override {
      committed.set_value();
      release.get_future().wait();
    }
  } publication;
  Limits limits;
  limits.lockTimeoutMs = 5;
  Admission native(world.catalog(), world.store(), publication, world.clock(), world.failures, limits);
  Admission rest(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limits);
  const auto created = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["First",null]}}]})");
  auto first = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return native.admit(ServerOrigin{world.account("A"), std::nullopt}, created, 1'000'000);
  });
  publication.committed.get_future().wait();
  auto changed = created;
  changed["d"][0]["id"] = "card0002";
  auto next = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return rest.admit(ServerOrigin{world.account("A"), std::nullopt}, changed, 1'000'001);
  });
  const bool waitedForPublication = next.wait_for(std::chrono::milliseconds(500)) == std::future_status::ready;
  publication.release.set_value();
  const auto initial = first.get();
  const auto second = next.get();
  CHECK(waitedForPublication);
  REQUIRE(std::holds_alternative<Admitted>(initial));
  CHECK_EQ(std::get<Admitted>(initial).result["s"].asString(), "ok");
  REQUIRE(std::holds_alternative<Retry>(second));
  CHECK_EQ(std::get<Retry>(second).afterMs, Retry::kTransientMs);
  CHECK_EQ(world.db().scopes.at(ScopeKey::product(world.account("A"), "probe")).seq, 1u);
}

TEST(admission_releases_the_scope_mutex_before_publication_completion_reaches_a_blocking_sink) {
  test::FakeWorld world;
  Limits limits;
  limits.lockTimeoutMs = 5;
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limits);
  std::promise<void> logged;
  auto loggedFuture = logged.get_future();
  std::promise<void> release;
  auto releaseFuture = release.get_future();
  std::atomic<bool> held{false};
  WriteCapture capture;
  installWriteSink([&](const WriteCompletion& completed) {
    if (completed.operation != "sync.publish" || held.exchange(true)) return;
    logged.set_value();
    releaseFuture.wait();
  });
  const auto intent = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["First",null]}}]})");
  auto first = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    return admission.admit(ServerOrigin{world.account("A"), std::nullopt}, intent, 1'000'000);
  });
  const bool loggingBlocked = loggedFuture.wait_for(std::chrono::milliseconds(500)) == std::future_status::ready;
  auto next = std::async(std::launch::async, [&] {
    BlockingThread::Mark blocking;
    auto nextIntent = intent;
    nextIntent["d"][0]["id"] = "card0002";
    return admission.admit(ServerOrigin{world.account("A"), std::nullopt}, nextIntent, 1'000'001);
  });
  const bool nextFinished = next.wait_for(std::chrono::milliseconds(500)) == std::future_status::ready;
  release.set_value();
  const auto initial = first.get();
  const auto second = next.get();
  CHECK(loggingBlocked);
  CHECK(nextFinished);
  REQUIRE(std::holds_alternative<Admitted>(initial));
  CHECK_EQ(std::get<Admitted>(initial).result["s"].asString(), "ok");
  REQUIRE(std::holds_alternative<Admitted>(second));
  CHECK_EQ(std::get<Admitted>(second).result["s"].asString(), "ok");
  CHECK_EQ(world.db().scopes.at(ScopeKey::product(world.account("A"), "probe")).seq, 2u);
  CHECK(world.failures.reports.empty());
}

TEST(admission_merges_a_text_past_the_work_bound_as_one_whole_conflict_and_marks_it_merged) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  const Json::Value intent = memoIntent(parseJson(R"({"text": "rose bleu", "base": {"text": "red bleu"}})"));
  const Json::Value ok = parseJson(R"({"s": "ok", "seq": 2})");
  auto memoAfter = [&world, &intent](const Limits& limits) {
    world.seed(markedOverlay());
    Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, limits);
    const AdmitOutcome outcome = admitFirst(world, admission, intent);
    const Json::Value result = std::holds_alternative<Admitted>(outcome) ? std::get<Admitted>(outcome).result : Json::Value();
    return std::pair(result, world.dump()["rows"]["acct:A/overlay/b_00000001"][0]["x"]["memo"]);
  };

  // Each script, from three base tokens to three side tokens, takes 16 cells.
  const auto [withinResult, withinMemo] = memoAfter(Limits{.mergeWorkCells = 16});
  const auto [pastResult, pastMemo] = memoAfter(Limits{.mergeWorkCells = 15});

  CHECK_EQ(jcs(withinResult), jcs(ok));
  CHECK_EQ(jcs(withinMemo), jcs(parseJson(R"({"text": "rose blue", "rev": 2, "merged": false})")));
  CHECK_EQ(jcs(pastResult), jcs(ok));
  CHECK_EQ(jcs(pastMemo), jcs(parseJson(R"({"text": "red blue\n\nrose bleu", "rev": 2, "merged": true})")));
}

TEST(admission_refuses_a_whole_text_conflict_past_the_field_cap_too_large_and_reports_nothing) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures, Limits{.mergeWorkCells = 15});
  const Json::Value intent = memoIntent(parseJson(R"({"text": "rose bleu, the colour of the sea", "base": {"text": "red bleu"}})"));

  const AdmitOutcome outcome = admitFirst(world, admission, intent);

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "too-large"})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, intent, refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_refuses_a_base_rev_past_the_safe_integers_invalid) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const Json::Value intent = memoIntent(parseJson(R"({"text": "red", "base": {"rev": 1e300}})"));

  const AdmitOutcome outcome = admitFirst(world, admission, intent);

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "invalid"})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, intent, refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_refuses_a_string_holding_u0000_invalid_wherever_it_sits) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  Json::Value inText(Json::objectValue);
  inText["text"] = std::string("red\0blue", 8);
  inText["base"]["rev"] = 1;
  Json::Value inBase(Json::objectValue);
  inBase["text"] = "red";
  inBase["base"]["text"] = std::string("\0", 1);

  const AdmitOutcome textOutcome = admitFirst(world, admission, memoIntent(inText));
  world.seed(markedOverlay());
  const AdmitOutcome baseOutcome = admitFirst(world, admission, memoIntent(inBase));

  const Json::Value refused = parseJson(R"({"s": "refused", "code": "invalid"})");
  REQUIRE(std::holds_alternative<Admitted>(textOutcome));
  CHECK_EQ(jcs(std::get<Admitted>(textOutcome).result), jcs(refused));
  REQUIRE(std::holds_alternative<Admitted>(baseOutcome));
  CHECK_EQ(jcs(std::get<Admitted>(baseOutcome).result), jcs(refused));
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(seeded, memoIntent(inBase), refused)));
  CHECK(world.failures.reports.empty());
}

TEST(admission_leaves_an_intent_of_a_replica_now_bound_to_another_account_unanswered) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Json::Value state = markedOverlay();
  state["replicas"]["rp_0000000000000000000000000000000a"]["account"] = "B";
  world.seed(state);
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);

  const AdmitOutcome admissible = admitFirst(world, admission, memoIntent(parseJson(R"({"text": "red", "base": {"rev": 1}})")));
  const AdmitOutcome refusable = admitFirst(world, admission, memoIntent(parseJson(R"({"text": "red", "base": {"rev": "one"}})")));

  REQUIRE(std::holds_alternative<OutOfTurn>(admissible));
  CHECK(std::get<OutOfTurn>(admissible).turn == Turn::foreign);
  REQUIRE(std::holds_alternative<OutOfTurn>(refusable));
  CHECK(std::get<OutOfTurn>(refusable).turn == Turn::foreign);
  CHECK_EQ(jcs(world.dump()), jcs(seeded));
  CHECK(world.feed.published.empty());
}

TEST(admission_binds_a_replica_again_when_a_push_s_409_took_its_binding_away) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  Json::Value state = markedOverlay();
  state.removeMember("replicas");
  world.seed(state);
  const Json::Value seeded = world.dump();
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const Json::Value intent = memoIntent(parseJson(R"({"text": "red blue", "base": {"rev": 1}})"));

  const AdmitOutcome outcome = admitFirst(world, admission, intent);

  const Json::Value ok = parseJson(R"({"s": "ok", "seq": 1})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(ok));
  Json::Value expected = seeded;
  expected["replicas"]["rp_0000000000000000000000000000000a"] = parseJson(R"({"account": "A", "lastN": 0})");
  CHECK_EQ(jcs(world.dump()), jcs(answeredOnly(expected, intent, ok)));
}

TEST(physical_clock_never_steps_back_when_the_wall_clock_does) {
  wm::fake::FakeClock wall;
  wall.now = 5'000;
  PhysicalClock physNow(wall);

  const std::uint64_t first = physNow.nowMs();
  wall.now = 4'000;
  const std::uint64_t afterStepBack = physNow.nowMs();
  wall.now = 6'000;
  const std::uint64_t afterCatchUp = physNow.nowMs();

  CHECK_EQ(first, 5'000u);
  CHECK_EQ(afterStepBack, 5'000u);
  CHECK_EQ(afterCatchUp, 6'000u);
}

TEST(admission_tallies_a_fault_in_step_r_s_write_toward_poison_for_a_replica) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  const Json::Value seeded = world.dump();
  wm::sync::fake::FaultingStore store(world.store(), wm::sync::fake::FaultingStore::Faults{.intents = {{1, FaultClass::fault}}});
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  const Json::Value refusable = memoIntent(parseJson(R"({"text": "red", "base": {"rev": "one"}})"));

  const AdmitOutcome outcome = admission.admit(ReplicaOrigin{world.account("A"), "rp_0000000000000000000000000000000a", 1, intentDigest(refusable)},
                                               refusable, 1'000'000);

  REQUIRE(std::holds_alternative<Retry>(outcome));
  CHECK_EQ(std::get<Retry>(outcome).afterMs, 0u);
  Json::Value expected = seeded;
  Json::Value tally = parseJson(R"({"n": 1, "result": null, "faults": 1})");
  tally["digest"] = intentDigest(refusable).hex();
  expected["results"]["rp_0000000000000000000000000000000a"].append(tally);
  CHECK_EQ(jcs(world.dump()), jcs(expected));
}

TEST(admission_ends_a_call_refused_internal_when_step_r_s_write_faults) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(markedOverlay());
  wm::sync::fake::FaultingStore store(world.store(), wm::sync::fake::FaultingStore::Faults{.parts = {{1, FaultClass::fault}}});
  Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
  const Json::Value refusable = memoIntent(parseJson(R"({"text": "red", "base": {"rev": "one"}})"));
  Json::Value call(Json::objectValue);
  call["tool"] = "memo.write";
  call["args"] = Json::Value(Json::objectValue);
  const Digest256 digest = intentDigest(call);

  const AdmitOutcome outcome = admission.admit(ServerOrigin{world.account("A"), CallPart{"req-1", 1, digest, true}}, refusable, 1'000'000);

  const Json::Value internal = parseJson(R"({"s": "refused", "code": "internal"})");
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), jcs(internal));
  Json::Value done = parseJson(R"({"A": [{"requestId": "req-1", "state": "done", "startedAt": 1000000,
      "parts": [{"k": 1, "result": {"s": "refused", "code": "internal"}}], "result": {"s": "refused", "code": "internal"}}]})");
  done["A"][0]["digest"] = digest.hex();
  CHECK_EQ(jcs(world.dump()["requests"]), jcs(done));
}
