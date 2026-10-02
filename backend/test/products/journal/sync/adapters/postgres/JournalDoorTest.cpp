#include "products/journal/sync/adapters/postgres/JournalDoor.h"
#include "products/journal/sync/adapters/postgres/PgJournalBackfill.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "products/journal/application/JournalSwitches.h"
#include "platform/infra/SyncProducts.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::sync;

namespace {

struct Switch {
  std::string name;
  std::optional<std::string> previous;
  Switch(std::string name, const char* value) : name(std::move(name)) {
    if (const char* old = std::getenv(this->name.c_str())) previous = old;
    setenv(this->name.c_str(), value, 1);
  }
  ~Switch() {
    if (previous) setenv(name.c_str(), previous->c_str(), 1);
    else unsetenv(name.c_str());
  }
};

struct Harness {
  UserId user{"77777777-7777-4777-8777-777777777779"};
  fake::FakeClock clock;
  struct Failures : FailureReporter {
    int calls = 0;
    void report(const std::string&, const std::string&, const std::string&) override { ++calls; }
  } failures;
  PgJournalRepository pages{pgTestPool()};
  struct Watcher : PageWatcher {
    PgJournalRepository& pages;
    int calls = 0;
    bool fail = false;
    explicit Watcher(PgJournalRepository& pages) : pages(pages) {}
    void pageSaved(const UserId& user, const LocalDate& day, std::size_t bytes) override {
      const auto page = pages.load(user, day);
      REQUIRE(page);
      CHECK_EQ(page->body.size(), bytes);
      ++calls;
      if (fail) throw std::runtime_error("watcher failure");
    }
  } watcher{pages};
  journal::JournalDoor door{pgTestPool(), clock, failures, watcher, productCatalog()};
  PageService service{pages, &watcher, &door};

  Harness() {
    PgLease lease{*pgTestPool()};
    pqxx::work sql{*lease};
    sql.exec("delete from sync_scopes where owner=$1::uuid", pqxx::params{user.str()});
    sql.exec("delete from users where id=$1::uuid", pqxx::params{user.str()});
    sql.exec("insert into users(id,email) values($1::uuid,'journal-door@example.com')", pqxx::params{user.str()});
    sql.commit();
  }

  Page incoming(std::uint64_t stamp = 1, std::string body = "Words.") {
    return Page{user, LocalDate("2026-10-01"), std::move(body), Score(0), std::nullopt, wm::Source::spoken,
        Hlc{stamp, 0, "writer"}, 0};
  }

  std::uint64_t seq() {
    PgLease lease{*pgTestPool()};
    pqxx::read_transaction sql{*lease};
    return sql.exec("select seq from sync_scopes where key=$1", pqxx::params{ScopeKey::product(user, "journal").text()})[0][0].as<std::uint64_t>();
  }
};

}

TEST(journal_engine_door_preserves_winners_stale_retries_revisions_and_postcommit_watcher) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  Switch enabled("JOURNAL_ENGINE_WRITES", "1");
  const auto first = h.service.write(h.incoming());
  CHECK_EQ(first.result, PageWrite::stored);
  CHECK_EQ(first.page.body, "Words.");
  CHECK_EQ(first.page.mood, std::optional<Score>(Score(0)));
  CHECK_EQ(first.page.updatedAtMs, h.clock.now);
  CHECK_EQ(h.watcher.calls, 1);
  const auto seq = h.seq();
  const auto stale = h.service.write(h.incoming(1, "Discard me."));
  CHECK_EQ(stale.result, PageWrite::ignoredStale);
  CHECK_EQ(stale.page, first.page);
  CHECK_EQ(h.seq(), seq);
  CHECK_EQ(h.watcher.calls, 1);
  h.watcher.fail = true;
  const auto second = h.service.write(h.incoming(2, "Words."));
  CHECK_EQ(second.result, PageWrite::superseded);
  CHECK_EQ(second.page.body, "Words.");
  CHECK_EQ(h.watcher.calls, 2);
  CHECK_EQ(h.failures.calls, 1);
  CHECK(h.seq() > seq);
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction sql{*lease};
  const auto revisions = sql.exec("select body,stamp_ms,engine_rev from journal_page_revision where user_id=$1::uuid", pqxx::params{h.user.str()});
  REQUIRE_EQ(revisions.size(), 1u);
  CHECK_EQ(revisions[0][0].as<std::string>(), "Words.");
  CHECK_EQ(revisions[0][1].as<std::uint64_t>(), 1u);
  CHECK_EQ(revisions[0][2].as<std::uint64_t>(), seq);
}

TEST(journal_engine_door_refuses_unadopted_history_and_inconsistent_admission_metadata) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  for (const std::string state : {"page", "revision", "partial-scope", "orphan-marker", "stale-admitted-scope",
                                 "state", "state-no-seq", "state-no-rc", "state-no-ru", "state-no-scope", "state-stale-scope"}) {
    Harness h;
    const bool admittedState = state.starts_with("state-");
    if (state == "stale-admitted-scope" || admittedState) {
      Switch enabled("JOURNAL_ENGINE_WRITES", "1");
      if (admittedState) {
        Json::Value fields(Json::objectValue);
        fields["placeholder"] = "retired";
        REQUIRE_EQ(h.door.journalState(h.user, fields)["s"].asString(), "ok");
      } else h.service.write(h.incoming());
    }
    {
      PgLease lease{*pgTestPool()};
      pqxx::work sql{*lease};
      if (state == "orphan-marker") {
        sql.exec("insert into journal_sync_adoptions(user_id,migration_ms,first_run_policy,manifest_digest,frozen_input) values($1::uuid,1,'retire-existing','x','{}')", pqxx::params{h.user.str()});
      } else if (state == "revision") {
        sql.exec("insert into journal_page_revision(user_id,day,body) values($1::uuid,'2026-09-30','History')", pqxx::params{h.user.str()});
      } else if (state == "stale-admitted-scope") {
        sql.exec("update sync_scopes set digest=decode(repeat('00',32),'hex') where key=$1", pqxx::params{ScopeKey::product(h.user, "journal").text()});
      } else if (state == "state") {
        sql.exec("insert into journal_sync_state(user_id,placeholder,placeholder_stamp) values($1::uuid,'retired','1:0:srv')", pqxx::params{h.user.str()});
      } else if (state == "state-no-seq" || state == "state-no-rc" || state == "state-no-ru") {
        const auto field = state.substr(std::string("state-no-").size());
        sql.exec("update journal_sync_state set " + field + "=null where user_id=$1::uuid", pqxx::params{h.user.str()});
      } else if (state == "state-no-scope") {
        sql.exec("delete from sync_scopes where key=$1", pqxx::params{ScopeKey::product(h.user, "journal").text()});
      } else if (state == "state-stale-scope") {
        sql.exec("update sync_scopes set digest=decode(repeat('00',32),'hex') where key=$1", pqxx::params{ScopeKey::product(h.user, "journal").text()});
      } else {
        sql.exec("insert into journal_page(user_id,day,body) values($1::uuid,'2026-09-30','History')", pqxx::params{h.user.str()});
      }
      if (state == "partial-scope") sql.exec("insert into sync_scopes(key,kind,owner) values($1,'product',$2::uuid)", pqxx::params{ScopeKey::product(h.user, "journal").text(), h.user.str()});
      sql.commit();
    }
    Switch enabled("JOURNAL_ENGINE_WRITES", "1");
    bool refused = false;
    try { h.service.write(h.incoming(2)); }
    catch (const journal::JournalUnavailable& error) { refused = error.code == "journal-not-adopted"; }
    CHECK(refused);
    PgLease lease{*pgTestPool()};
    pqxx::read_transaction sql{*lease};
    const auto scopes = sql.exec("select key from sync_scopes where key=$1", pqxx::params{ScopeKey::product(h.user, "journal").text()});
    CHECK_EQ(scopes.size(), state == "partial-scope" || state == "stale-admitted-scope" ||
        (admittedState && state != "state-no-scope") ? 1u : 0u);
    CHECK_EQ(h.failures.calls, 0);
  }
}

TEST(journal_engine_partial_first_run_retirement_allows_later_state_save_and_claim) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  Switch enabled("JOURNAL_ENGINE_WRITES", "1");
  Json::Value fields(Json::objectValue);
  fields["placeholder"] = "retired";
  REQUIRE_EQ(h.door.journalState(h.user, fields)["s"].asString(), "ok");
  const auto retired = h.seq();
  {
    PgLease lease{*pgTestPool()};
    pqxx::read_transaction sql{*lease};
    const auto rows = sql.exec("select * from journal_sync_state where user_id=$1::uuid", pqxx::params{h.user.str()});
    REQUIRE_EQ(rows.size(), 1u);
    CHECK_EQ(rows[0]["placeholder"].as<std::string>(), "retired");
    CHECK(!rows[0]["placeholder_stamp"].is_null());
    for (const char* stamp : {"privacy_line_stamp", "first_page_stamp", "scales_stamp"}) CHECK(rows[0][stamp].is_null());
    CHECK_EQ(rows[0]["seq"].as<Seq>(), retired);
    CHECK(!rows[0]["rc"].is_null());
    CHECK(!rows[0]["ru"].is_null());
    CHECK(sql.exec("select 1 from journal_sync_adoptions where user_id=$1::uuid", pqxx::params{h.user.str()}).empty());
  }
  fields = Json::Value(Json::objectValue);
  fields["privacyLine"] = "retired";
  REQUIRE_EQ(h.door.journalState(h.user, fields)["s"].asString(), "ok");
  CHECK(h.seq() > retired);
  CHECK_EQ(h.watcher.calls, 0);
  const auto saved = h.service.write(h.incoming());
  CHECK_EQ(saved.result, PageWrite::stored);
  CHECK_EQ(saved.page.body, "Words.");
  Json::Value claim(Json::objectValue);
  claim["day"] = "2026-10-01";
  claim["body"] = "Here.";
  claim["mood"] = Json::nullValue;
  claim["energy"] = 0;
  claim["source"] = "typed";
  claim["claimId"] = "partial-retirement-claim";
  REQUIRE_EQ(h.door.claimPage(h.user, claim)["s"].asString(), "ok");
  const auto claimed = h.pages.load(h.user, LocalDate("2026-10-01"));
  REQUIRE(claimed);
  CHECK_EQ(claimed->body, "Words.\n\nHere.");
  CHECK_EQ(claimed->mood, std::optional<Score>(Score(0)));
  CHECK_EQ(claimed->energy, std::optional<Score>(Score(0)));
  CHECK_EQ(h.watcher.calls, 2);
  CHECK_EQ(h.failures.calls, 0);
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction sql{*lease};
  const auto state = sql.exec("select placeholder,placeholder_stamp,privacy_line,privacy_line_stamp,first_page_stamp,scales_stamp from journal_sync_state where user_id=$1::uuid", pqxx::params{h.user.str()});
  REQUIRE_EQ(state.size(), 1u);
  CHECK_EQ(state[0]["placeholder"].as<std::string>(), "retired");
  CHECK_EQ(state[0]["privacy_line"].as<std::string>(), "retired");
  CHECK(!state[0]["placeholder_stamp"].is_null());
  CHECK(!state[0]["privacy_line_stamp"].is_null());
  CHECK(state[0]["first_page_stamp"].is_null());
  CHECK(state[0]["scales_stamp"].is_null());
  CHECK_EQ(sql.exec("select count(*) from journal_claim_receipts where user_id=$1::uuid", pqxx::params{h.user.str()})[0][0].as<int>(), 1);
}

TEST(journal_engine_internal_claim_and_state_are_admitted_retry_safe_and_frozen) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  Switch enabled("JOURNAL_ENGINE_WRITES", "1");
  h.service.write(h.incoming());
  Json::Value claim(Json::objectValue);
  claim["day"] = "2026-10-01";
  claim["body"] = "Here.";
  claim["mood"] = Json::nullValue;
  claim["energy"] = 0;
  claim["source"] = "typed";
  claim["claimId"] = "claim-1";
  CHECK_EQ(h.door.claimPage(h.user, claim)["s"].asString(), "ok");
  const auto head = h.seq();
  CHECK_EQ(h.pages.load(h.user, LocalDate("2026-10-01"))->body, "Words.\n\nHere.");
  CHECK_EQ(h.door.claimPage(h.user, claim)["s"].asString(), "ok");
  CHECK_EQ(h.seq(), head);
  CHECK_EQ(h.watcher.calls, 2);
  claim["body"] = "Changed.";
  CHECK_EQ(h.door.claimPage(h.user, claim)["code"].asString(), "claim-conflict");
  Json::Value fields(Json::objectValue);
  fields["placeholder"] = "retired";
  CHECK_EQ(h.door.journalState(h.user, fields)["s"].asString(), "ok");
  CHECK(h.seq() > head);
  CHECK_EQ(h.watcher.calls, 2);
  Switch frozen("JOURNAL_WRITE_FREEZE", "1");
  for (int door = 0; door < 3; ++door) {
    bool refused = false;
    try {
      if (door == 0) h.door.savePage(h.incoming());
      if (door == 1) h.door.claimPage(h.user, claim);
      if (door == 2) h.door.journalState(h.user, fields);
    } catch (const journal::JournalUnavailable& error) { refused = error.code == "journal-frozen"; }
    CHECK(refused);
  }
}

TEST(journal_engine_door_uses_backfilled_history_and_disables_direct_legacy_save) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  h.pages.save(h.incoming());
  journal::engine::PgJournalBackfill backfill(pgTestPool());
  backfill.run(h.clock.now, false, h.user.str());
  CHECK_EQ(h.watcher.calls, 0);
  Switch enabled("JOURNAL_ENGINE_WRITES", "1");
  const auto out = h.service.write(h.incoming(2));
  CHECK_EQ(out.result, PageWrite::superseded);
  CHECK_EQ(h.watcher.calls, 1);
  bool refused = false;
  try { h.pages.save(h.incoming(3)); }
  catch (const journal::JournalUnavailable& error) { refused = error.code == "journal-engine-required"; }
  CHECK(refused);
}

TEST(journal_adoption_preserves_equal_stamp_since_cohorts_at_limit_boundaries) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  Harness h;
  for (const char* day : {"2026-09-03", "2026-09-01", "2026-09-02"}) {
    Page incoming(h.user, LocalDate(day));
    incoming.body = day;
    incoming.stamp = Hlc{100, 2, "same"};
    h.pages.save(incoming);
  }
  Switch enabled("JOURNAL_ENGINE_WRITES", "1");
  std::vector<std::vector<Page>> before;
  for (const int limit : {1, 2, 500}) before.push_back(h.pages.since(h.user, Hlc{0, 0, ""}, limit));
  journal::engine::PgJournalBackfill(pgTestPool()).run(h.clock.now, false, h.user.str());
  int index = 0;
  for (const int limit : {1, 2, 500}) {
    const auto pages = h.pages.since(h.user, Hlc{0, 0, ""}, limit);
    CHECK_EQ(pages, before[index++]);
    for (std::size_t day = 0; day < pages.size(); ++day)
      CHECK_EQ(pages[day].day.iso(), "2026-09-0" + std::to_string(day + 1));
  }
  CHECK(h.pages.since(h.user, Hlc{100, 2, "same"}, 500).empty());
}
