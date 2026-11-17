#include "platform/application/sync/ServerCall.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/WriteObservation.h"
#include "test/SyncCorpus.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

#include <algorithm>
#include <typeinfo>

using namespace wm;
using namespace wm::sync;

namespace {

struct BuilderWriteCapture {
  std::vector<WriteCompletion> completed;
  BuilderWriteCapture() { installWriteSink([this](const WriteCompletion& write) { completed.push_back(write); }); }
  ~BuilderWriteCapture() { installWriteSink({}); }
};

class BuilderScopeStore final : public fake::ForwardingStore {
public:
  explicit BuilderScopeStore(SyncStore& store) : ForwardingStore(store) {}
  std::vector<std::pair<ScopeKey, RowLock>> locks;
  std::optional<ScopeRow> scope(SyncTxn& txn, const ScopeKey& key, RowLock mode) override {
    if (mode != RowLock::none) locks.emplace_back(key, mode);
    return ForwardingStore::scope(txn, key, mode);
  }
};

}

TEST(server_builder_writes_the_owners_tree_under_its_scope_lock) {
  BlockingThread::Mark blocking;
  test::FakeWorld world;
  world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"tree:b_00000001":{"kind":"tree","owner":"A","state":"alive","seq":0,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000","governedBy":"acct:A/probe#board#b_00000001"}}})"));
  Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
  ServerCall call(admission, world.store(), world.account("A"), "req-tree-builder", "tree.rename", {});
  const auto placeholder = parseJson(R"({"scope":"tree/b_00000001","d":[{"t":"meta","id":"meta","f":{"title":["Plan",null]}}]})");
  int builds = 0;
  const auto outcome = call.admitBuilt(placeholder, 1'000'000, [&](SyncTxn& txn) -> std::optional<Json::Value> {
    ++builds;
    const auto tree = world.store().scope(txn, ScopeKey::tree("b_00000001"), RowLock::none);
    CHECK(tree.has_value());
    if (tree) CHECK_EQ(tree->seq, 0u);
    return placeholder;
  });
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(jcs(std::get<Admitted>(outcome).result), R"({"s":"ok","seq":1})");
  CHECK_EQ(builds, 1);
  CHECK_EQ(world.feed.published.size(), 1u);
  const auto committed = world.dump();
  ServerCall takeover(admission, world.store(), world.account("A"), "req-tree-builder", "tree.rename", {});
  const auto resumed = takeover.admitBuilt(placeholder, 1'000'000 + admission.limits().requestLeaseMs,
      [&](SyncTxn&) -> std::optional<Json::Value> { ++builds; return placeholder; });
  REQUIRE(std::holds_alternative<Admitted>(resumed));
  CHECK_EQ(jcs(std::get<Admitted>(resumed).result), jcs(std::get<Admitted>(outcome).result));
  CHECK_EQ(jcs(world.dump()), jcs(committed));
  CHECK_EQ(builds, 1);
  takeover.finish(std::get<Admitted>(resumed).result, 1'000'000 + admission.limits().requestLeaseMs);
  const auto finished = world.dump();
  ServerCall replay(admission, world.store(), world.account("A"), "req-tree-builder", "tree.rename", {});
  const auto repeated = replay.admitBuilt(placeholder, 1'000'001 + admission.limits().requestLeaseMs,
      [&](SyncTxn&) -> std::optional<Json::Value> { ++builds; return placeholder; });
  REQUIRE(std::holds_alternative<CallAnswered>(repeated));
  CHECK_EQ(jcs(std::get<CallAnswered>(repeated).result), jcs(std::get<Admitted>(outcome).result));
  CHECK_EQ(jcs(world.dump()), jcs(finished));
  CHECK_EQ(builds, 1);
  CHECK_EQ(world.feed.published.size(), 1u);
}

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

TEST(server_builder_tree_access_and_stamps_match_the_shared_server_vectors) {
  BlockingThread::Mark blocking;
  for (const char* file : {"/corpus/admit/access.json", "/corpus/admit/server-stamps.json"}) {
    const auto vectors = corpus::readCorpusFile(std::string(WM_SYNC_CONTRACT_DIR) + file);
    for (const auto& vector : vectors) {
      const auto& input = vector["input"];
      if (input["origin"]["kind"] != "server" || input["intent"]["scope"].asString() == "self/probe") continue;
      test::FakeWorld world;
      world.seed(input["state"]);
      BuilderScopeStore store(world.store());
      Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
      ServerCall call(admission, store, world.account(input["origin"]["account"].asString()), std::nullopt, "tree.edit", {});
      BuilderWriteCapture capture;
      int builds = 0;
      const auto outcome = call.admitBuilt(input["intent"], input["serverNow"].asUInt64(), [&](SyncTxn& txn) -> std::optional<Json::Value> {
        ++builds;
        const auto scope = resolve(world.catalog().registry(), input["intent"]["scope"].asString(), world.account(input["origin"]["account"].asString()));
        CHECK(scope.has_value());
        if (scope) {
          const auto locked = store.scope(txn, *scope, RowLock::none);
          CHECK(locked.has_value());
          const std::vector<std::pair<ScopeKey, RowLock>> expected{{*scope, RowLock::noKeyUpdate}};
          CHECK(store.locks == expected);
        }
        return input["intent"];
      });
      REQUIRE(std::holds_alternative<Admitted>(outcome));
      corpus::checkSame(std::get<Admitted>(outcome).result, vector["expect"]["result"], __FILE__, __LINE__);
      corpus::checkSame(world.dump(), vector["expect"]["state"], __FILE__, __LINE__);
      const bool allowed = vector["expect"]["result"]["s"] == "ok";
      CHECK_EQ(builds, allowed ? 1 : 0);
      REQUIRE_EQ(world.feed.published.size(), allowed ? 1u : 0u);
      if (allowed) {
        const auto& publication = world.feed.published.front();
        CHECK_EQ(publication.epoch, input["state"]["epoch"].asString());
        CHECK(publication.killed.empty());
        REQUIRE_EQ(publication.changed.size(), 1u);
        const auto& change = publication.changed.front();
        const auto& expectedScope = vector["expect"]["state"]["scopes"][change.key.text()];
        CHECK_EQ(change.key.ref(), input["intent"]["scope"].asString());
        CHECK_EQ(change.owner.str(), expectedScope["owner"].asString());
        CHECK_EQ(change.seq, expectedScope["seq"].asUInt64());
        CHECK_EQ(change.digest.hex(), expectedScope["digest"].asString());
        std::vector<std::string> expectedRows;
        for (const auto& row : vector["expect"]["state"]["rows"][change.key.text()]) {
          if (row["seq"].asUInt64() == change.seq) expectedRows.push_back(jcs(row));
        }
        std::vector<std::string> rows;
        for (const auto& row : change.rows) rows.push_back(jcs(row));
        std::sort(rows.begin(), rows.end());
        std::sort(expectedRows.begin(), expectedRows.end());
        CHECK(rows == expectedRows);
      }
      REQUIRE_EQ(capture.completed.size(), allowed ? 2u : 1u);
      if (allowed) {
        CHECK_EQ(capture.completed.front().operation, "sync.publish");
        CHECK_EQ(capture.completed.front().product, "probe");
        CHECK_EQ(capture.completed.front().door, "background");
        CHECK_EQ(capture.completed.front().outcome, "ok");
      }
      const auto& observation = capture.completed.back();
      CHECK_EQ(observation.operation, "sync.admit");
      CHECK_EQ(observation.product, input["intent"]["scope"].asString().starts_with("acct:") ? "platform" : "probe");
      CHECK_EQ(observation.door, "server-origin");
      CHECK_EQ(observation.outcome, allowed ? "ok" : vector["expect"]["result"]["code"].asString());
      CHECK(observation.metadata.empty());
      CHECK(observation.durationMs >= 0);
      CHECK(world.failures.reports.empty());
    }
  }
}

TEST(server_builder_creates_only_the_callers_overlay_of_a_readable_tree) {
  BlockingThread::Mark blocking;
  auto document = parseJson(probe::registryText());
  for (auto& type : document["types"]) if (type["type"] == "mark") type["origins"].append("server");
  const Registry registry(document);
  const auto vectors = corpus::readCorpusFile(std::string(WM_SYNC_CONTRACT_DIR) + "/corpus/admit/access.json");
  for (const auto& vector : vectors) {
    const auto& input = vector["input"];
    if (input["origin"]["kind"] != "replica" || !input["intent"]["scope"].asString().starts_with("self/overlay/")) continue;
    test::FakeWorld world;
    world.seed(input["state"]);
    const auto before = world.dump();
    SyncCatalog catalog(registry);
    for (const auto& type : registry.types()) catalog.bindType(world.catalog().store(type.name), world.catalog().rules(type.name));
    for (const auto& command : registry.commands()) catalog.bindCommand(command.name, world.catalog().command(command.name));
    catalog.seal();
    BuilderScopeStore store(world.store());
    Admission admission(catalog, store, world.feed, world.clock(), world.failures);
    const auto account = world.account(input["origin"]["account"].asString());
    const auto scope = *resolve(registry, input["intent"]["scope"].asString(), account);
    auto intent = input["intent"];
    intent["d"][0]["f"]["done"][1] = Json::nullValue;
    ServerCall call(admission, store, account, std::nullopt, "overlay.mark", {});
    int builds = 0;
    const auto outcome = call.admitBuilt(intent, 1'000'000, [&](SyncTxn& txn) -> std::optional<Json::Value> {
      ++builds;
      const std::vector<std::pair<ScopeKey, RowLock>> expected{{scope.governingTree(), RowLock::keyShare}, {scope, RowLock::noKeyUpdate}};
      CHECK(store.locks == expected);
      const auto overlay = store.scope(txn, scope, RowLock::none);
      CHECK(overlay.has_value());
      if (overlay) {
        CHECK_EQ(overlay->owner, account);
        CHECK_EQ(overlay->governedBy, std::optional(scope.governingTree().text()));
      }
      return intent;
    });
    REQUIRE(std::holds_alternative<Admitted>(outcome));
    corpus::checkSame(std::get<Admitted>(outcome).result, vector["expect"]["result"], __FILE__, __LINE__);
    const bool allowed = vector["expect"]["result"]["s"] == "ok";
    CHECK_EQ(builds, allowed ? 1 : 0);
    auto expected = vector["expect"]["state"];
    if (allowed) {
      expected["clock"] = parseJson(R"({"ms":1000000,"counter":0})");
      auto& rows = expected["rows"][scope.text()];
      for (auto& row : rows) row["f"]["done"][1] = "1000000:0:srv";
      expected["scopes"][scope.text()]["digest"] = scopeDigest(std::vector<Json::Value>(rows.begin(), rows.end())).hex();
      REQUIRE_EQ(world.feed.published.size(), 1u);
      const auto& publication = world.feed.published.front();
      CHECK_EQ(publication.epoch, expected["epoch"].asString());
      CHECK(publication.killed.empty());
      REQUIRE_EQ(publication.changed.size(), 1u);
      const auto& change = publication.changed.front();
      CHECK_EQ(change.key, scope);
      CHECK_EQ(change.owner, account);
      CHECK_FALSE(change.open);
      CHECK_EQ(change.seq, expected["scopes"][scope.text()]["seq"].asUInt64());
      CHECK_EQ(change.digest.hex(), expected["scopes"][scope.text()]["digest"].asString());
      Json::Value frameRows(Json::arrayValue);
      for (const auto& row : change.rows) frameRows.append(row);
      CHECK_EQ(jcs(frameRows), jcs(rows));
    } else {
      CHECK(world.feed.published.empty());
    }
    corpus::checkSame(world.dump(), expected, __FILE__, __LINE__);
    CHECK_EQ(jcs(world.dump()["rows"]["tree:b_00000001"]), jcs(before["rows"]["tree:b_00000001"]));
    if (account.str() == "B") CHECK_EQ(jcs(world.dump()["rows"]["acct:A/overlay/b_00000001"]), jcs(before["rows"]["acct:A/overlay/b_00000001"]));
    CHECK(world.failures.reports.empty());
  }
}

TEST(server_builder_tree_noop_refusal_and_fault_preserve_state_and_replay) {
  BlockingThread::Mark blocking;
  for (const std::string mode : {"noop", "fault", "abort", "scope"}) {
    test::FakeWorld world;
    world.seed(parseJson(R"({"epoch":"e","accounts":{"A":{"name":"Ann"}},"scopes":{"tree:b_00000001":{"kind":"tree","owner":"A","state":"alive","seq":7,"counters":{},"digest":"0000000000000000000000000000000000000000000000000000000000000000","governedBy":"acct:A/probe#board#b_00000001"}}})"));
    const auto before = world.dump();
    Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
    const auto placeholder = parseJson(R"({"scope":"tree/b_00000001","d":[{"t":"meta","id":"meta","f":{"title":["Next",null]}}]})");
    int builds = 0;
    const auto builder = [&](SyncTxn& txn) -> std::optional<Json::Value> {
      ++builds;
      if (mode == "noop") return std::nullopt;
      fake::dbOf(txn).scopes.at(ScopeKey::tree("b_00000001")).seq = 99;
      if (mode == "fault") throw std::runtime_error("PRIVATE-TREE-CONTENT");
      if (mode == "abort") throw ServerBuildAborted{std::make_exception_ptr(std::invalid_argument("PRIVATE-INPUT"))};
      auto otherScope = placeholder;
      otherScope["scope"] = "tree/b_00000002";
      return otherScope;
    };
    ServerCall call(admission, world.store(), world.account("A"), "PRIVATE-REQUEST", "PRIVATE-TOOL", Json::Value("PRIVATE-ARGUMENT"), "probe");
    BuilderWriteCapture capture;
    WriteContext context("builder-test");
    Json::Value result;
    bool aborted = false;
    try {
      const auto outcome = call.admitBuilt(placeholder, 1'000'000, builder);
      REQUIRE(std::holds_alternative<Admitted>(outcome));
      result = std::get<Admitted>(outcome).result;
    } catch (const std::invalid_argument& error) {
      CHECK_EQ(std::string(error.what()), "PRIVATE-INPUT");
      aborted = true;
    }
    CHECK_EQ(aborted, mode == "abort");
    CHECK_EQ(builds, 1);
    auto after = world.dump();
    after.removeMember("requests");
    CHECK_EQ(jcs(after), jcs(before));
    CHECK(world.feed.published.empty());
    REQUIRE_EQ(capture.completed.size(), 1u);
    const auto& observation = capture.completed.front();
    CHECK_EQ(observation.operation, "sync.admit");
    CHECK_EQ(observation.product, "probe");
    CHECK_EQ(observation.door, "server-origin");
    CHECK_EQ(observation.outcome, mode == "fault" ? "failed" : mode == "noop" ? "ok" : "invalid");
    CHECK_EQ(observation.requestId, "builder-test");
    CHECK(observation.metadata.empty());
    CHECK(writeCompletionJson(observation).find("PRIVATE") == std::string::npos);
    if (mode == "fault") {
      const std::vector<std::string> expected{"probe sync.admit door=server-origin outcome=failed request_id=builder-test exception_type=" + std::string(typeid(std::runtime_error).name())};
      CHECK(world.failures.reports == expected);
    } else {
      CHECK(world.failures.reports.empty());
    }
    if (aborted) {
      CHECK_EQ(jcs(world.dump()), jcs(before));
      continue;
    }
    CHECK_EQ(jcs(result), mode == "noop" ? R"({"s":"ok","seq":7})" : mode == "fault" ? R"({"code":"internal","s":"refused"})" : R"({"code":"invalid","s":"refused"})");
    call.finish(result, 1'000'000);
    const auto stored = world.dump();
    ServerCall replay(admission, world.store(), world.account("A"), "PRIVATE-REQUEST", "PRIVATE-TOOL", Json::Value("PRIVATE-ARGUMENT"), "probe");
    const auto repeated = replay.admitBuilt(placeholder, 1'000'001, builder);
    REQUIRE(std::holds_alternative<CallAnswered>(repeated));
    CHECK_EQ(jcs(std::get<CallAnswered>(repeated).result), jcs(result));
    CHECK_EQ(jcs(world.dump()), jcs(stored));
    CHECK_EQ(builds, 1);
    CHECK(world.feed.published.empty());
  }
}

TEST(server_builder_commands_use_only_the_initial_ordered_tree_lock_pass) {
  BlockingThread::Mark blocking;
  const auto vectors = corpus::readCorpusFile(std::string(WM_SYNC_CONTRACT_DIR) + "/corpus/admit/commands.json");
  Json::Value copy;
  for (const auto& vector : vectors) {
    if (vector["input"]["intent"]["cmd"]["name"] == "probe.copy" && vector["expect"]["result"]["s"] == "ok") {
      copy = vector;
      break;
    }
  }
  REQUIRE(copy.isObject());
  for (const std::string mode : {"declared", "introduced", "changed"}) {
    test::FakeWorld world;
    world.seed(copy["input"]["state"]);
    const auto before = world.dump();
    BuilderScopeStore store(world.store());
    Admission admission(world.catalog(), store, world.feed, world.clock(), world.failures);
    auto placeholder = copy["input"]["intent"];
    if (mode == "introduced") placeholder = parseJson(R"({"scope":"self/probe","cmd":{"name":"probe.tick","args":{}}})");
    auto built = copy["input"]["intent"];
    if (mode == "changed") built["cmd"]["args"]["dst"] = "b_0000000f";
    ServerCall call(admission, store, world.account("A"), std::nullopt, "tree.copy", {});
    int builds = 0;
    const auto outcome = call.admitBuilt(placeholder, copy["input"]["serverNow"].asUInt64(), [&](SyncTxn&) -> std::optional<Json::Value> {
      ++builds;
      std::vector<std::pair<ScopeKey, RowLock>> expected{{ScopeKey::product(world.account("A"), "probe"), RowLock::noKeyUpdate}};
      if (mode != "introduced") {
        std::set<ScopeKey> trees{ScopeKey::tree(placeholder["cmd"]["args"]["src"].asString()), ScopeKey::tree(placeholder["cmd"]["args"]["dst"].asString())};
        for (const auto& tree : trees) expected.emplace_back(tree, RowLock::share);
      }
      CHECK(store.locks == expected);
      return built;
    });
    REQUIRE(std::holds_alternative<Admitted>(outcome));
    CHECK_EQ(builds, 1);
    if (mode == "declared") {
      corpus::checkSame(std::get<Admitted>(outcome).result, copy["expect"]["result"], __FILE__, __LINE__);
      corpus::checkSame(world.dump(), copy["expect"]["state"], __FILE__, __LINE__);
    } else {
      CHECK_EQ(jcs(std::get<Admitted>(outcome).result), R"({"code":"invalid","s":"refused"})");
      CHECK_EQ(jcs(world.dump()), jcs(before));
      CHECK(world.feed.published.empty());
    }
    CHECK(world.failures.reports.empty());
  }
}
