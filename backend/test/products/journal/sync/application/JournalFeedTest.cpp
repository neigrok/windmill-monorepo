#include "products/journal/sync/application/JournalFeed.h"
#include "platform/application/WorkerPool.h"
#include "test/platform/application/sync/SyncWorld.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::sync;

TEST(journal_watcher_runs_after_commit_once_for_the_winning_document) {
  BlockingThread::Mark blocking;
  sync::test::FakeWorld world(false, true);
  struct Watcher final : PageWatcher {
    sync::test::FakeWorld& world;
    int calls = 0;
    std::size_t bytes = 0;
    bool fail = false;
    explicit Watcher(sync::test::FakeWorld& world) : world(world) {}
    void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) override {
      const auto row = world.db().rows.find(RecordRef{ScopeKey::product(user, "journal"), "page", RecordId(day.iso())});
      CHECK(row != world.db().rows.end());
      if (row != world.db().rows.end()) CHECK_EQ(row->second.x.at("body").text.size(), bodyBytes);
      ++calls;
      bytes = bodyBytes;
      if (fail) throw std::runtime_error("watcher failed");
    }
  } watcher(world);
  journal::engine::JournalFeed feed(watcher, world.feed);
  Admission admission(world.catalog(), world.store(), feed, world.clock(), world.failures);
  auto intent = parseJson(R"({"scope":"self/journal","cmd":{"name":"journal.savePage","args":{"day":"2026-10-01","body":"Words.","mood":0,"energy":null,"source":"typed","stamp":{"ms":1,"counter":0,"actor":"writer"}}}})");
  const ServerOrigin origin{UserId("A"), std::nullopt};
  auto outcome = admission.admit(origin, intent, 100);
  REQUIRE(std::holds_alternative<Admitted>(outcome));
  CHECK_EQ(std::get<Admitted>(outcome).result["s"].asString(), "ok");
  CHECK_EQ(watcher.calls, 1);
  CHECK_EQ(watcher.bytes, 6u);
  outcome = admission.admit(origin, intent, 101);
  CHECK_EQ(watcher.calls, 1);
  CHECK(std::get<Admitted>(outcome).result["write"].empty());
  intent["cmd"]["args"]["stamp"]["ms"] = 2;
  intent["cmd"]["args"]["body"] = "Next.";
  watcher.fail = true;
  outcome = admission.admit(origin, intent, 102);
  CHECK_EQ(std::get<Admitted>(outcome).result["s"].asString(), "ok");
  CHECK_EQ(watcher.calls, 2);
  CHECK_EQ(world.db().rows.at(RecordRef{ScopeKey::product(UserId("A"), "journal"), "page", RecordId(std::string("2026-10-01"))}).x.at("body").text, "Next.");
  CHECK_EQ(world.failures.reports.size(), 1u);
}

TEST(journal_watcher_is_attempted_when_the_live_feed_fails) {
  struct Watcher final : PageWatcher {
    int calls = 0;
    void pageSaved(const UserId&, const LocalDate&, std::size_t bytes) override { ++calls; CHECK_EQ(bytes, 6u); }
  } watcher;
  struct BrokenFeed final : ChangeFeed {
    void publish(const CommittedChange&) override { throw std::runtime_error("live feed failed"); }
  } next;
  journal::engine::JournalFeed feed(watcher, next);
  ScopeChange scope{ScopeKey::product(UserId("A"), "journal"), UserId("A")};
  scope.rows.push_back(parseJson(R"({"t":"page","id":"2026-10-01","x":{"body":{"text":"Words."}}})"));
  bool failed = false;
  try { feed.publish(CommittedChange{"ep-1", {scope}, {}}); } catch (const std::runtime_error&) { failed = true; }
  CHECK(failed);
  CHECK_EQ(watcher.calls, 1);
}
