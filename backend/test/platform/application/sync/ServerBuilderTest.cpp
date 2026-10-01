#include "platform/application/sync/ServerCall.h"
#include "platform/application/WorkerPool.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::sync;

TEST(server_builder_reads_the_locked_scope_and_request_replay_skips_the_builder) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"acct:A/probe":{"kind":"product","owner":"A","state":"alive","seq":0,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000"}}})"));
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  const auto scope = ScopeKey::product(world.account("A"), "probe");
  const auto placeholder = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["One",null]}}]})");
  int builds = 0;
  const auto builder = [&](SyncTxn& txn) -> std::optional<Json::Value> {
    ++builds;
    const auto held = world.store().scope(txn, scope, RowLock::none);
    CHECK(held.has_value());
    CHECK_EQ(held->seq, 0u);
    return placeholder;
  };
  ServerCall first(admission, world.store(), world.account("A"), "req-builder", "add", Json::Value());
  const auto landed = first.admitBuilt(placeholder, 1'000'000, builder);
  REQUIRE(std::holds_alternative<Admitted>(landed));
  const auto result = std::get<Admitted>(landed).result;
  CHECK_EQ(result["s"].asString(), "ok");
  first.finish(result, 1'000'000);
  ServerCall replay(admission, world.store(), world.account("A"), "req-builder", "add", Json::Value());
  const auto repeated = replay.admitBuilt(placeholder, 1'000'001, builder);
  REQUIRE(std::holds_alternative<CallAnswered>(repeated));
  CHECK_EQ(jcs(std::get<CallAnswered>(repeated).result), jcs(result));
  CHECK_EQ(builds, 1);
}

TEST(server_builder_with_no_changes_leaves_seq_and_feed_unchanged) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"acct:A/probe":{"kind":"product","owner":"A","state":"alive","seq":7,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000"}}})"));
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  ServerCall call(admission, world.store(), world.account("A"), std::nullopt, "noop", {});
  const auto placeholder = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["One",null]}}]})");
  const auto outcome = call.admitBuilt(placeholder, 1'000'000, [](SyncTxn&) -> std::optional<Json::Value> { return std::nullopt; });
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(std::get<Admitted>(outcome).result["seq"].asUInt64(), 7u);
  CHECK(world.feed.published.empty());
}

TEST(server_builder_storage_fault_finishes_the_request_with_internal) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"acct:A/probe":{"kind":"product","owner":"A","state":"alive","seq":7,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000"}}})"));
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  ServerCall call(admission, world.store(), world.account("A"), "req-fault", "fault", {});
  const auto placeholder = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["One",null]}}]})");
  int builds = 0;
  const auto builder = [&](SyncTxn&) -> std::optional<Json::Value> { ++builds; throw std::runtime_error("storage fault"); };
  const auto failed = call.admitBuilt(placeholder, 1'000'000, builder);
  REQUIRE(std::holds_alternative<Admitted>(failed));
  CHECK_EQ(jcs(std::get<Admitted>(failed).result), R"({"code":"internal","s":"refused"})");
  ServerCall retry(admission, world.store(), world.account("A"), "req-fault", "fault", {});
  const auto replay = retry.admitBuilt(placeholder, 1'000'001, builder);
  REQUIRE(std::holds_alternative<CallAnswered>(replay));
  CHECK_EQ(jcs(std::get<CallAnswered>(replay).result), jcs(std::get<Admitted>(failed).result));
  CHECK_EQ(builds, 1);
  CHECK(world.feed.published.empty());
}

TEST(server_builder_input_refusal_rolls_back_without_a_request_part) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"acct:A/probe":{"kind":"product","owner":"A","state":"alive","seq":7,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000"}}})"));
  const auto before = jcs(world.dump());
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  ServerCall call(admission, world.store(), world.account("A"), "req-input", "invalid", {});
  const auto placeholder = parseJson(R"({"scope":"self/probe","d":[{"t":"card","id":"card0001","born":null,"life":["alive",null],"f":{"title":["One",null]}}]})");
  bool refused = false;
  try {
    call.admitBuilt(placeholder, 1'000'000, [](SyncTxn&) -> std::optional<Json::Value> {
      throw ServerBuildAborted{std::make_exception_ptr(std::invalid_argument("bad input"))};
    });
  } catch (const std::invalid_argument& error) {
    refused = std::string(error.what()) == "bad input";
  }
  CHECK(refused);
  CHECK_EQ(jcs(world.dump()), before);
  CHECK(world.feed.published.empty());
}
