#include "products/journal/sync/adapters/postgres/PgJournal.h"
#include "products/journal/sync/adapters/json/JournalIntent.h"
#include "products/journal/sync/domain/JournalRules.h"
#include "products/journal/sync/application/JournalFeed.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "platform/application/WorkerPool.h"

#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

using namespace wm;
using namespace wm::sync;

namespace {

Json::Value retentionVector(const Json::Value& input) {
  static test::PgWorld world(false, true);
  world.seed(parseJson(R"({"accounts":{"A":{"name":"A"}}})"));
  const auto scope = ScopeKey::product(world.account("A"), "journal");
  auto txn = world.store().begin(TxnMode::write);
  auto& sql = sqlOf(*txn);
  std::map<std::string, std::string> calendarDays;
  auto day = [&](const std::string& name) {
    if (!calendarDays.contains(name)) {
      const auto value = sql.exec("select (date '2000-01-01'+$1::int)::text", pqxx::params{static_cast<int>(calendarDays.size())});
      calendarDays[name] = value[0][0].as<std::string>();
    }
    return calendarDays.at(name);
  };
  for (const auto& row : input["revisions"])
    sql.exec("insert into journal_page_revision(user_id,day,body,superseded_at,engine_rev) values($1::uuid,$2::date,$3,to_timestamp($4::numeric/1000),$5)", pqxx::params{scope.account().str(), day(row["day"].asString()), std::string(row["bytes"].asUInt64(), 'x'), row["archivedAt"].asInt64(), row["rev"].asInt64()});
  std::set<std::string> affected;
  for (const auto& name : input["days"]) affected.insert(day(name.asString()));
  journal::engine::PgJournalType page(*journal::engine::registry().type("page"));
  page.pruneRevisions(*txn, scope, affected, input["serverNow"].asUInt64());
  Json::Value answer(Json::objectValue);
  answer["kept"] = Json::Value(Json::arrayValue);
  for (const auto& row : sql.exec("select engine_rev from journal_page_revision where user_id=$1::uuid order by superseded_at desc,engine_rev desc", pqxx::params{scope.account().str()})) answer["kept"].append(Json::UInt64(row[0].template as<Seq>()));
  return answer;
}

[[maybe_unused]] const bool registered = [] {
  corpus::registerFiles(WM_SYNC_CONTRACT_DIR "/corpus", {{"journal/revisions.json", corpus::Runner{retentionVector}}}, [] { return test::postgresEnabled() ? nullptr : test::kNeedsPostgres; });
  const auto vectors = corpus::readCorpusFile(WM_SYNC_CONTRACT_DIR "/corpus/journal/admit.json");
  for (const std::string name : {"page", "journalState"})
    ::testing::Register{"journal_store_round_trip/" + name, [name, vectors] {
      if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
      test::PgWorld world(false, true);
      bool exercised = false;
      for (const auto& vector : vectors) {
        const auto state = vector["input"]["state"];
        bool present = false;
        for (const auto& key : state["rows"].getMemberNames()) for (const auto& row : state["rows"][key]) present |= row["t"] == name;
        if (!present) continue;
        world.seed(state);
        auto txn = world.store().begin(TxnMode::write);
        auto& type = world.catalog().store(name);
        for (const auto& key : state["rows"].getMemberNames()) {
          const auto scope = world.storeKey(key);
          std::map<std::string, Row> expected;
          for (const auto& wire : state["rows"][key]) {
            if (wire["t"] != name) continue;
            const Row row(wire);
            expected.emplace(row.id.key(), row);
            type.apply(*txn, scope, {RowWrite{world.catalog().registry().type(name), row.id, row, row, {}}});
            const auto locked = type.lock(*txn, scope, {row.id});
            CHECK_EQ(jcs(locked.at(row.id.key()).toJson()), jcs(row.toJson()));
          }
          CHECK_EQ(type.count(*txn, scope, FeedQuery{}), expected.size());
          for (const Row& fed : type.feed(*txn, scope, FeedQuery{})) {
            CHECK_EQ(jcs(fed.toJson()), jcs(expected.at(fed.id.key()).toJson()));
            CHECK_EQ(rowHash(fed.toJson()).hex(), rowHash(expected.at(fed.id.key()).toJson()).hex());
          }
        }
        exercised = true;
        break;
      }
      CHECK(exercised);
    }};
  return true;
}();

}

TEST(journal_claim_receipts_and_content_clock_are_transactional_and_purged) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  test::PgWorld world(false, true);
  world.seed(parseJson(R"({"accounts":{"A":{"name":"A"}}})"));
  journal::engine::PgJournalState book;
  const auto scope = ScopeKey::product(world.account("A"), "journal");
  const auto receipt = parseJson(R"({"digest":"abc","day":"2026-10-01","documentStamp":{"ms":1234,"counter":2,"actor":"srv"}})");
  const auto clock = parseJson(R"({"ms":1234,"counter":2})");
  {
    auto txn = world.store().begin(TxnMode::write);
    book.receipt(*txn, scope, "claim-1", receipt);
    book.saveClock(*txn, scope, clock);
  }
  {
    auto txn = world.store().begin(TxnMode::write);
    CHECK(book.load(*txn, scope).empty());
    book.receipt(*txn, scope, "claim-1", receipt);
    book.saveClock(*txn, scope, clock);
    txn->commit();
  }
  {
    auto txn = world.store().begin(TxnMode::write);
    const auto loaded = book.load(*txn, scope);
    CHECK_EQ(jcs(loaded["claims"]["claim-1"]), jcs(receipt));
    CHECK_EQ(jcs(loaded["contentClock"]), jcs(clock));
    world.catalog().store("page").purge(*txn, scope);
    CHECK(book.load(*txn, scope).empty());
    txn->commit();
  }
}

TEST(journal_normalized_rest_builder_keeps_legacy_reads_winners_receipts_and_notices) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world(false, true);
  world.seed(parseJson(R"({"accounts":{"A":{"name":"A"}}})"));
  const auto user = world.account("A");
  const LocalDate day("2026-10-01");
  const Ms now = 1'760'000'000'000;
  PgJournalRepository rest(pgTestPool());
  struct Watcher final : PageWatcher {
    explicit Watcher(PgJournalRepository& repository) : repository(repository) {}
    void pageSaved(const UserId& user, const LocalDate& day, std::size_t bytes) override {
      const auto page = repository.load(user, day);
      REQUIRE(page.has_value());
      CHECK_EQ(page->body.size(), bytes);
      pages.push_back(wm::toJson(*page));
    }
    PgJournalRepository& repository;
    std::vector<Json::Value> pages;
  } watcher(rest);
  journal::engine::JournalFeed feed(watcher, world.feed);
  Admission admission(world.catalog(), world.store(), feed, world.clock(), world.failures);
  auto accepted = [&](const Json::Value& raw, Ms at) -> Seq {
    const auto wire = journal::engine::savePageIntent(raw, user, day);
    const auto outcome = admission.admit(ServerOrigin{user, std::nullopt}, wire, at);
    const auto* result = std::get_if<Admitted>(&outcome);
    if (!result) throw std::logic_error("normalized journal REST intent was not admitted");
    CHECK_EQ(result->result["s"].asString(), "ok");
    CHECK_FALSE(result->result["write"].empty());
    auto expected = wm::toJson(parsePageWrite(raw, user, day));
    expected["updatedAt"] = Json::UInt64(at);
    const auto page = rest.load(user, day);
    if (!page) throw std::logic_error("accepted journal REST intent has no page");
    CHECK_EQ(jcs(wm::toJson(*page)), jcs(expected));
    CHECK_EQ(jcs(watcher.pages.back()), jcs(expected));
    return result->result["seq"].asUInt64();
  };
  CHECK_EQ(accepted(Json::Value(Json::objectValue), now), 1u);
  CHECK_EQ(jcs(journal::engine::savePageIntent(Json::Value(Json::objectValue), user, day)),
    jcs(parseJson(R"({"scope":"self/journal","d":[],"cmd":{"name":"journal.savePage","args":{"day":"2026-10-01","body":"","mood":null,"energy":null,"source":"typed","stamp":{"ms":0,"counter":0,"actor":""}}}})")));
  const auto words = parseJson(R"({"body":"  café\n","mood":99,"energy":"unset","source":"unknown","stamp":"9000000000000:7:writer:phone"})");
  const auto firstRev = accepted(words, now + 1);
  const auto kept = parseJson(R"({"body":"Kept","mood":0,"energy":0,"source":"spoken","stamp":"9000000000000:8:writer:phone"})");
  const auto secondRev = accepted(kept, now + 2);
  const auto winner = wm::toJson(*rest.load(user, day));
  const auto before = world.dump();
  const auto notices = watcher.pages.size();
  auto stale = kept;
  stale["body"] = "losing words";
  stale["mood"] = 10;
  stale["energy"] = Json::nullValue;
  stale["source"] = "typed";
  const auto staleOutcome = admission.admit(ServerOrigin{user, std::nullopt}, journal::engine::savePageIntent(stale, user, day), now + 100);
  const auto* staleResult = std::get_if<Admitted>(&staleOutcome);
  REQUIRE(staleResult != nullptr);
  CHECK_EQ(staleResult->result["s"].asString(), "ok");
  CHECK(staleResult->result["write"].empty());
  CHECK_EQ(jcs(world.dump()), jcs(before));
  CHECK_EQ(jcs(wm::toJson(*rest.load(user, day))), jcs(winner));
  CHECK_EQ(watcher.pages.size(), notices);
  stale["body"] = std::string(journal::engine::kMaxPageBytes + 1, 'x');
  bool tooLarge = false;
  try { journal::engine::savePageIntent(stale, user, day); }
  catch (const PageTooLarge&) { tooLarge = true; }
  CHECK(tooLarge);
  CHECK_EQ(jcs(world.dump()), jcs(before));
  CHECK_EQ(watcher.pages.size(), notices);
  const auto cleared = parseJson(R"({"stamp":"9000000000000:9:writer:phone"})");
  accepted(cleared, now + 3);
  CHECK_EQ(watcher.pages.size(), 4u);
  CHECK_EQ(world.feed.published.size(), 4u);
  CHECK(world.clock().state().ms <= now + 3);
  CHECK(world.failures.reports.empty());
  auto txn = world.store().begin(TxnMode::snapshot);
  const auto scope = ScopeKey::product(user, "journal");
  CHECK_EQ(world.catalog().store("page").count(*txn, scope, FeedQuery{.visibleOnly = true}), 0u);
  CHECK_EQ(world.catalog().store("page").count(*txn, scope, FeedQuery{}), 1u);
  auto& mutablePage = world.catalog().store("page");
  const auto firstAudit = mutablePage.revisionText(*txn, scope, RecordId(day.iso()), "body", firstRev);
  const auto secondAudit = mutablePage.revisionText(*txn, scope, RecordId(day.iso()), "body", secondRev);
  REQUIRE(firstAudit.has_value());
  REQUIRE(secondAudit.has_value());
  CHECK_EQ(*firstAudit, words["body"].asString());
  CHECK_EQ(*secondAudit, "Kept");
}
