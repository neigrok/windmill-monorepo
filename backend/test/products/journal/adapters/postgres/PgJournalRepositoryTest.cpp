#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "products/journal/application/PageService.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>
#include <thread>

// Opt-in integration test: it needs a live local Postgres with the schema applied. It runs only
// when WM_PG_TEST is set — otherwise every case here reports `skip`, which the run summary counts
// as skipped and never as passed (RUNNING.md §7 has the invocation). It seeds its own user
// row so it is fully self-contained. This is the one test that proves the SQL half — the LWW guard,
// the revision capture, the round-trip mapping — against a real server rather than a fake.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kUser = "11111111-1111-1111-1111-111111111111";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'journal-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM journal_page WHERE user_id = '" + kUser + "'");
  w.exec("DELETE FROM journal_page_revision WHERE user_id = '" + kUser + "'");
  w.commit();
}
Page page(const std::string& body, Mood mood, Energy energy, Source source, const Hlc& stamp) {
  Page p{UserId{kUser}, LocalDate{"2026-07-27"}};
  p.body = body;
  p.mood = mood;
  p.energy = energy;
  p.source = source;
  p.stamp = stamp;
  return p;
}
}

TEST(pg_journal_save_then_load_roundtrips_every_field) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  CHECK_EQ(repo.save(page("round trip", Mood::m3, Energy::e2, Source::spoken, Hlc{500, 0, "devZ"})),
           PageWrite::stored);

  std::optional<Page> got = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(got.has_value());
  CHECK_EQ(got->day.iso(), std::string("2026-07-27"));
  CHECK_EQ(got->body, std::string("round trip"));
  CHECK(got->mood == Mood::m3);
  CHECK(got->energy == Energy::e2);
  CHECK(got->source == Source::spoken);
  CHECK_EQ(got->stamp.physicalMs, static_cast<std::uint64_t>(500));
  CHECK_EQ(got->stamp.actor, std::string("devZ"));
}

TEST(pg_journal_lww_and_revision_trail) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  CHECK_EQ(repo.save(page("first light", Mood::m4, Energy::e2, Source::typed, Hlc{100, 0, "devA"})),
           PageWrite::stored);
  // an older stamp from another device loses and writes nothing
  CHECK_EQ(repo.save(page("stale", Mood::m1, Energy::e1, Source::typed, Hlc{50, 0, "devB"})),
           PageWrite::ignoredStale);
  // a newer stamp wins and supersedes
  CHECK_EQ(repo.save(page("clearer now", Mood::m5, Energy::e3, Source::spoken, Hlc{200, 0, "devB"})),
           PageWrite::superseded);

  std::optional<Page> got = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(got.has_value());
  CHECK_EQ(got->body, std::string("clearer now"));

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  // exec1 (not query_value) so this compiles on the CI's pinned libpqxx 7.x as well as mac's 8.x.
  int revisions = w.exec1(
      "SELECT count(*)::int FROM journal_page_revision WHERE user_id = '" + kUser + "'")[0].as<int>();
  CHECK_EQ(revisions, 1);   // only 'first light' was superseded; the ignored 'stale' wrote nothing
}

// The exact combination the server runs and no other test covers: PageService calling
// PgJournalRepository through the JournalRepository& port (a virtual call), then reading the
// returned page. This is where the live server was losing the body — reproducing it here, with no
// drogon in the picture, localises whether the fault is the call chain itself or the HTTP runtime.
TEST(pg_journal_through_pageservice_keeps_the_body) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  PageService service{repo};

  service.write(page("via the service", Mood::m3, Energy::e2, Source::typed, Hlc{300, 0, "devQ"}));
  std::optional<Page> got = service.page(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(got.has_value());
  CHECK_EQ(got->body, std::string("via the service"));
  CHECK_EQ(got->day.iso(), std::string("2026-07-27"));
}

// The server serves every request on a drogon WORKER THREAD, never the main thread, and a
// repository borrows its connection from a pool shared across all of them. This runs the same read
// on a fresh worker thread — if the live server loses the body but this keeps it, the fault is the
// HTTP runtime, not the storage.
TEST(pg_journal_through_pageservice_on_a_worker_thread) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  PageService service{repo};
  service.write(page("off-thread", Mood::m2, Energy::e1, Source::spoken, Hlc{400, 0, "devW"}));

  std::optional<Page> got;
  std::vector<Page> listed;
  std::thread worker([&] {
    got = service.page(UserId{kUser}, LocalDate{"2026-07-27"});
    listed = service.all(UserId{kUser});
  });
  worker.join();

  REQUIRE(got.has_value());
  CHECK_EQ(got->body, std::string("off-thread"));
  REQUIRE_EQ(listed.size(), static_cast<std::size_t>(1));
  CHECK_EQ(listed.front().body, std::string("off-thread"));
}
