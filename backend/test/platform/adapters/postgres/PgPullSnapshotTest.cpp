#include "platform/application/WorkerPool.h"
#include "platform/application/sync/Admission.h"
#include "platform/application/sync/SyncService.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "test/platform/Fakes.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/ServeCorpusRunners.h"
#include "test/testing.h"

#include <atomic>
#include <string>
#include <thread>
#include <vector>

// §6.7 over Postgres while a writer commits: each page's rows, seq and digest come from one snapshot, so a
// whole boot page sums to its digest exactly (INV-15), and a row a write moves after a boot began arrives
// above the boot's asOf in the live phase (INV-5).

using namespace wm;
using namespace wm::sync;

namespace {

constexpr Ms kNow = 1'000'000;

test::PgWorld& world() {
  static test::PgWorld pg;
  return pg;
}

Json::Value dayPut(const std::string& day, int score, std::uint32_t counter) {
  const std::string stamp = std::to_string(kNow) + ":" + std::to_string(counter) + ":r_aaaaaaaaaaaa";
  Json::Value intent = parseJson(R"({"scope":"self/probe","d":[{"t":"day","id":")" + day + R"(","life":["alive",")" + stamp +
                                 R"("],"f":{"score":[)" + std::to_string(score) + R"(,")" + stamp + R"("]}}]})");
  return intent;
}

std::string dayOf(int index) {
  char day[11];
  std::snprintf(day, sizeof day, "2026-%02d-%02d", 1 + index / 28, 1 + index % 28);
  return day;
}

std::string pullRequest(const std::string& cursor) {
  Json::Value request(Json::objectValue);
  Json::Value& scope = request["scopes"].append(Json::Value(Json::objectValue));
  scope["scope"] = "self/probe";
  scope["cursor"] = cursor.empty() ? Json::Value(Json::nullValue) : Json::Value(cursor);
  return jcs(request);
}

}

TEST(a_boot_page_read_while_a_writer_commits_sums_to_its_own_digest_at_its_own_seq) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  world().seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}}})"));
  Admission admission(world().catalog(), world().store(), world().feed, world().clock(), world().failures);
  wm::fake::FakeClock clock;
  clock.now = kNow;
  SyncService service(world().catalog(), world().store(), admission, clock);
  const UserId ann = world().account("A");
  BlockingThread::Mark blocking;
  for (int day = 0; day < 40; ++day) admission.admit(ServerOrigin{ann, std::nullopt}, dayPut(dayOf(day), 0, 1), kNow);

  std::atomic<bool> writing{true};
  std::thread writer([&] {
    BlockingThread::Mark writerBlocking;
    for (std::uint32_t round = 2; round < 300; ++round) admission.admit(ServerOrigin{ann, std::nullopt}, dayPut(dayOf(static_cast<int>(round % 40)), round % 10, round), kNow);
    writing = false;
  });
  int boots = 0;
  int mismatches = 0;
  while (writing) {
    const Json::Value page = service.pull(Credential::sent(ann), pullRequest("")).body["pages"][0];
    std::vector<Json::Value> rows(page["rows"].begin(), page["rows"].end());
    const bool whole = !page["more"].asBool() && page["total"].asUInt64() == rows.size();
    const bool atItsSeq = std::all_of(rows.begin(), rows.end(), [&page](const Json::Value& row) { return row["seq"].asUInt64() <= page["seq"].asUInt64(); });
    if (!whole || !atItsSeq || scopeDigest(rows).hex() != page["digest"].asString()) ++mismatches;
    ++boots;
  }
  writer.join();
  CHECK_EQ(mismatches, 0);
  CHECK_EQ(boots > 0, true);
}

TEST(a_row_moved_after_a_boot_began_arrives_above_its_as_of_in_the_live_phase) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  world().seed(parseJson(R"({"epoch": "ep-1", "clock": {"ms": 0, "counter": 0}, "accounts": {"A": {"name": "Ann"}}})"));
  Limits small;
  small.pullPageBytes = 150;
  Admission admission(world().catalog(), world().store(), world().feed, world().clock(), world().failures, small);
  wm::fake::FakeClock clock;
  clock.now = kNow;
  SyncService service(world().catalog(), world().store(), admission, clock);
  const UserId ann = world().account("A");
  BlockingThread::Mark blocking;
  for (int day = 0; day < 6; ++day) admission.admit(ServerOrigin{ann, std::nullopt}, dayPut(dayOf(day), 0, 1), kNow);

  Json::Value page = service.pull(Credential::sent(ann), pullRequest("")).body["pages"][0];
  const std::uint64_t asOf = page["seq"].asUInt64();
  CHECK_EQ(page["more"].asBool(), true);
  admission.admit(ServerOrigin{ann, std::nullopt}, dayPut(dayOf(5), 9, 2), kNow);

  std::vector<std::string> booted;
  std::vector<std::string> live;
  for (;;) {
    for (const Json::Value& row : page["rows"]) (row["seq"].asUInt64() <= asOf ? booted : live).push_back(row["id"].asString() + "@" + row["seq"].asString());
    if (!page["more"].asBool()) break;
    page = service.pull(Credential::sent(ann), pullRequest(page["cursor"].asString())).body["pages"][0];
  }
  CHECK_EQ(booted, (std::vector<std::string>{dayOf(0) + "@1", dayOf(1) + "@2", dayOf(2) + "@3", dayOf(3) + "@4", dayOf(4) + "@5"}));
  CHECK_EQ(live, (std::vector<std::string>{dayOf(5) + "@7"}));
}
