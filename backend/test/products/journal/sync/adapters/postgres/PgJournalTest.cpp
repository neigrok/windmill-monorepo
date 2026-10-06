#include "products/journal/sync/adapters/postgres/PgJournal.h"
#include "products/journal/adapters/json/PageJson.h"
#include "products/journal/sync/domain/JournalRules.h"
#include "products/journal/sync/application/JournalFeed.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "platform/application/WorkerPool.h"

#include "test/SyncCorpus.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

using namespace wm;
using namespace wm::sync;

namespace {

Json::Value journalIntent() {
  Json::Value intent(Json::objectValue);
  intent["scope"] = "self/journal";
  intent["d"] = Json::Value(Json::arrayValue);
  return intent;
}

// journal.savePage as a phone pushes it.
Json::Value savePage(const std::string& day, const std::string& body, const Json::Value& mood, const Json::Value& energy,
                     const std::string& source, Ms ms, std::uint64_t counter, const std::string& actor) {
  Json::Value intent = journalIntent();
  intent["cmd"]["name"] = "journal.savePage";
  auto& args = intent["cmd"]["args"];
  args["day"] = day;
  args["body"] = body;
  args["mood"] = mood;
  args["energy"] = energy;
  args["source"] = source;
  args["stamp"]["ms"] = Json::UInt64(ms);
  args["stamp"]["counter"] = Json::UInt64(counter);
  args["stamp"]["actor"] = actor;
  return intent;
}

Json::Value claimPage(const Json::Value& args) {
  Json::Value intent = journalIntent();
  intent["cmd"]["name"] = "journal.claimPage";
  intent["cmd"]["args"] = args;
  return intent;
}

// The first-run register written field by field, as the journal app retires each pending step.
Json::Value journalState(const Json::Value& fields) {
  Json::Value intent = journalIntent();
  Json::Value delta(Json::objectValue);
  delta["t"] = "journalState";
  delta["id"] = "journalState";
  for (const auto& field : fields.getMemberNames()) {
    delta["f"][field] = Json::Value(Json::arrayValue);
    delta["f"][field].append(fields[field]);
    delta["f"][field].append(Json::nullValue);
  }
  intent["d"].append(delta);
  return intent;
}

Json::Value admitted(Admission& admission, const UserId& user, const Json::Value& intent, Ms at) {
  const auto outcome = admission.admit(ServerOrigin{user, std::nullopt}, intent, at);
  const auto* result = std::get_if<Admitted>(&outcome);
  if (!result) throw std::logic_error("journal intent was not admitted");
  return result->result;
}

Seq scopeSeq(const UserId& user) {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction sql{*lease};
  return sql.exec("select seq from sync_scopes where key=$1", pqxx::params{ScopeKey::product(user, "journal").text()})[0][0].as<Seq>();
}

struct CountingWatcher final : PageWatcher {
  int calls = 0;
  void pageSaved(const UserId&, const LocalDate&, std::size_t) override { ++calls; }
};

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

TEST(journal_admitted_pages_read_back_through_the_rest_reads_with_their_notices_and_revisions) {
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
  auto accepted = [&](const Json::Value& intent, Ms at) -> Seq {
    const auto result = admitted(admission, user, intent, at);
    CHECK_EQ(result["s"].asString(), "ok");
    CHECK_FALSE(result["write"].empty());
    const auto& args = intent["cmd"]["args"];
    Json::Value expected(Json::objectValue);
    expected["day"] = args["day"];
    expected["body"] = args["body"];
    expected["mood"] = args["mood"];
    expected["energy"] = args["energy"];
    expected["source"] = args["source"];
    expected["stamp"] = std::to_string(args["stamp"]["ms"].asUInt64()) + ":" + std::to_string(args["stamp"]["counter"].asUInt64()) +
                        ":" + args["stamp"]["actor"].asString();
    expected["updatedAt"] = Json::UInt64(at);
    const auto page = rest.load(user, day);
    if (!page) throw std::logic_error("an admitted journal page has no row");
    CHECK_EQ(jcs(wm::toJson(*page)), jcs(expected));
    CHECK_EQ(jcs(watcher.pages.back()), jcs(expected));
    return result["seq"].asUInt64();
  };
  CHECK_EQ(accepted(savePage("2026-10-01", "", Json::nullValue, Json::nullValue, "typed", 0, 0, ""), now), 1u);
  const auto firstRev = accepted(savePage("2026-10-01", "  café\n", Json::nullValue, Json::nullValue, "typed",
                                          9'000'000'000'000, 7, "writer:phone"), now + 1);
  const auto secondRev = accepted(savePage("2026-10-01", "Kept", 0, 0, "spoken", 9'000'000'000'000, 8, "writer:phone"), now + 2);
  const auto winner = wm::toJson(*rest.load(user, day));
  const auto before = world.dump();
  const auto notices = watcher.pages.size();
  const auto stale = admitted(admission, user,
      savePage("2026-10-01", "losing words", 10, Json::nullValue, "typed", 9'000'000'000'000, 8, "writer:phone"), now + 100);
  CHECK_EQ(stale["s"].asString(), "ok");
  CHECK(stale["write"].empty());
  CHECK_EQ(jcs(world.dump()), jcs(before));
  CHECK_EQ(jcs(wm::toJson(*rest.load(user, day))), jcs(winner));
  CHECK_EQ(watcher.pages.size(), notices);
  accepted(savePage("2026-10-01", "", Json::nullValue, Json::nullValue, "typed", 9'000'000'000'000, 9, "writer:phone"), now + 3);
  CHECK_EQ(watcher.pages.size(), 4u);
  CHECK_EQ(world.feed.published.size(), 4u);
  CHECK(world.clock().state().ms <= now + 3);
  CHECK(world.failures.reports.empty());
  auto txn = world.store().begin(TxnMode::snapshot);
  const auto scope = ScopeKey::product(user, "journal");
  CHECK_EQ(world.catalog().store("page").count(*txn, scope, FeedQuery{.visibleOnly = true}), 0u);
  CHECK_EQ(world.catalog().store("page").count(*txn, scope, FeedQuery{}), 1u);
  auto& pages = world.catalog().store("page");
  const auto firstAudit = pages.revisionText(*txn, scope, RecordId(day.iso()), "body", firstRev);
  const auto secondAudit = pages.revisionText(*txn, scope, RecordId(day.iso()), "body", secondRev);
  REQUIRE(firstAudit.has_value());
  REQUIRE(secondAudit.has_value());
  CHECK_EQ(*firstAudit, "  café\n");
  CHECK_EQ(*secondAudit, "Kept");
}

TEST(journal_partial_first_run_retirement_allows_a_later_state_save_page_save_and_claim) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world(false, true);
  world.seed(parseJson(R"({"accounts":{"A":{"name":"A"}}})"));
  const auto user = world.account("A");
  const Ms now = 1'760'000'000'000;
  CountingWatcher watcher;
  journal::engine::JournalFeed feed(watcher, world.feed);
  Admission admission(world.catalog(), world.store(), feed, world.clock(), world.failures);
  PgJournalRepository pages(pgTestPool());

  Json::Value fields(Json::objectValue);
  fields["placeholder"] = "retired";
  REQUIRE_EQ(admitted(admission, user, journalState(fields), now)["s"].asString(), "ok");
  const auto retired = scopeSeq(user);
  {
    PgLease lease{*pgTestPool()};
    pqxx::read_transaction sql{*lease};
    const auto rows = sql.exec("select * from journal_sync_state where user_id=$1::uuid", pqxx::params{user.str()});
    REQUIRE_EQ(rows.size(), 1u);
    CHECK_EQ(rows[0]["placeholder"].as<std::string>(), "retired");
    CHECK(!rows[0]["placeholder_stamp"].is_null());
    for (const char* stamp : {"privacy_line_stamp", "first_page_stamp", "scales_stamp"}) CHECK(rows[0][stamp].is_null());
    CHECK_EQ(rows[0]["seq"].as<Seq>(), retired);
    CHECK(!rows[0]["rc"].is_null());
    CHECK(!rows[0]["ru"].is_null());
  }
  fields = Json::Value(Json::objectValue);
  fields["privacyLine"] = "retired";
  REQUIRE_EQ(admitted(admission, user, journalState(fields), now + 1)["s"].asString(), "ok");
  CHECK(scopeSeq(user) > retired);
  CHECK_EQ(watcher.calls, 0);
  REQUIRE_EQ(admitted(admission, user, savePage("2026-10-01", "Words.", 0, Json::nullValue, "spoken", 1, 0, "writer"), now + 2)["s"].asString(), "ok");
  CHECK_EQ(pages.load(user, LocalDate("2026-10-01"))->body, "Words.");
  Json::Value claim(Json::objectValue);
  claim["day"] = "2026-10-01";
  claim["body"] = "Here.";
  claim["mood"] = Json::nullValue;
  claim["energy"] = 0;
  claim["source"] = "typed";
  claim["claimId"] = "partial-retirement-claim";
  REQUIRE_EQ(admitted(admission, user, claimPage(claim), now + 3)["s"].asString(), "ok");
  const auto claimed = pages.load(user, LocalDate("2026-10-01"));
  REQUIRE(claimed);
  CHECK_EQ(claimed->body, "Words.\n\nHere.");
  CHECK_EQ(claimed->mood, std::optional<Score>(Score(0)));
  CHECK_EQ(claimed->energy, std::optional<Score>(Score(0)));
  CHECK_EQ(watcher.calls, 2);
  CHECK(world.failures.reports.empty());
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction sql{*lease};
  const auto state = sql.exec("select placeholder,placeholder_stamp,privacy_line,privacy_line_stamp,first_page_stamp,scales_stamp from journal_sync_state where user_id=$1::uuid", pqxx::params{user.str()});
  REQUIRE_EQ(state.size(), 1u);
  CHECK_EQ(state[0]["placeholder"].as<std::string>(), "retired");
  CHECK_EQ(state[0]["privacy_line"].as<std::string>(), "retired");
  CHECK(!state[0]["placeholder_stamp"].is_null());
  CHECK(!state[0]["privacy_line_stamp"].is_null());
  CHECK(state[0]["first_page_stamp"].is_null());
  CHECK(state[0]["scales_stamp"].is_null());
  CHECK_EQ(sql.exec("select count(*) from journal_claim_receipts where user_id=$1::uuid", pqxx::params{user.str()})[0][0].as<int>(), 1);
}

TEST(journal_claim_replays_without_a_write_and_a_changed_claim_conflicts) {
  if (!test::postgresEnabled()) SKIP(test::kNeedsPostgres);
  BlockingThread::Mark blocking;
  test::PgWorld world(false, true);
  world.seed(parseJson(R"({"accounts":{"A":{"name":"A"}}})"));
  const auto user = world.account("A");
  const Ms now = 1'760'000'000'000;
  CountingWatcher watcher;
  journal::engine::JournalFeed feed(watcher, world.feed);
  Admission admission(world.catalog(), world.store(), feed, world.clock(), world.failures);
  PgJournalRepository pages(pgTestPool());

  REQUIRE_EQ(admitted(admission, user, savePage("2026-10-01", "Words.", 0, Json::nullValue, "spoken", 1, 0, "writer"), now)["s"].asString(), "ok");
  Json::Value claim(Json::objectValue);
  claim["day"] = "2026-10-01";
  claim["body"] = "Here.";
  claim["mood"] = Json::nullValue;
  claim["energy"] = 0;
  claim["source"] = "typed";
  claim["claimId"] = "claim-1";
  CHECK_EQ(admitted(admission, user, claimPage(claim), now + 1)["s"].asString(), "ok");
  const auto head = scopeSeq(user);
  CHECK_EQ(pages.load(user, LocalDate("2026-10-01"))->body, "Words.\n\nHere.");
  CHECK_EQ(admitted(admission, user, claimPage(claim), now + 2)["s"].asString(), "ok");
  CHECK_EQ(scopeSeq(user), head);
  CHECK_EQ(watcher.calls, 2);
  claim["body"] = "Changed.";
  CHECK_EQ(admitted(admission, user, claimPage(claim), now + 3)["code"].asString(), "claim-conflict");
  Json::Value fields(Json::objectValue);
  fields["placeholder"] = "retired";
  CHECK_EQ(admitted(admission, user, journalState(fields), now + 4)["s"].asString(), "ok");
  CHECK(scopeSeq(user) > head);
  CHECK_EQ(watcher.calls, 2);
  CHECK(world.failures.reports.empty());
}
