#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "products/journal/application/PageService.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>
#include <thread>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every case reports skip. It seeds its own user row.
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
// March 1st onward, day by day, so a test that needs eighty distinct pages can name them; LocalDate refuses an impossible one.
std::string dayOfMarchOnwards(int index) {
  static constexpr int lengths[] = {31, 30, 31};   // March, April, May 2026
  int month = 3;
  while (index >= lengths[month - 3]) {
    index -= lengths[month - 3];
    ++month;
  }
  const std::string day = std::to_string(index + 1);
  return "2026-0" + std::to_string(month) + "-" + (day.size() == 1 ? "0" + day : day);
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

TEST(pg_journal_revision_trail_keeps_only_a_days_last_few) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  for (int write = 1; write <= 15; ++write)
    repo.save(page("body " + std::to_string(write), Mood::m1, Energy::e1, Source::typed,
                   Hlc{static_cast<std::uint64_t>(100 * write), 0, "devA"}));

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page_revision WHERE user_id = '" + kUser +
                   "'")[0].as<int>(),
           10);
  CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page_revision WHERE user_id = '" + kUser +
                   "' AND body = 'body 1'")[0].as<int>(),
           0);
  CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page_revision WHERE user_id = '" + kUser +
                   "' AND body = 'body 14'")[0].as<int>(),
           1);
  CHECK_EQ(repo.load(UserId{kUser}, LocalDate{"2026-07-27"})->body, std::string("body 15"));
}

TEST(pg_journal_revision_trail_is_bounded_per_user_by_bytes) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  const std::string big(kMaxPageBytes, 'x');   // the largest page the write boundary will accept

  for (int index = 0; index < 80; ++index) {
    Page first{UserId{kUser}, LocalDate{dayOfMarchOnwards(index)}};
    first.body = big;
    first.stamp = Hlc{100, 0, "devA"};
    Page second = first;
    second.stamp = Hlc{200, 0, "devA"};
    repo.save(first);
    repo.save(second);
  }

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  const long long bytes =
      w.exec1("SELECT coalesce(sum(octet_length(body)), 0)::bigint FROM journal_page_revision "
              "WHERE user_id = '" + kUser + "'")[0].as<long long>();
  CHECK(bytes <= 8LL * 1024 * 1024);
  CHECK(bytes > 7LL * 1024 * 1024);   // it keeps what it can, rather than emptying the trail
}

TEST(pg_journal_revision_trail_forgets_what_is_older_than_the_retention) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  repo.save(page("old body", Mood::m1, Energy::e1, Source::typed, Hlc{100, 0, "devA"}));
  repo.save(page("newer body", Mood::m1, Energy::e1, Source::typed, Hlc{200, 0, "devA"}));
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec("UPDATE journal_page_revision SET superseded_at = now() - interval '91 days' "
           "WHERE user_id = '" + kUser + "'");
    w.commit();
  }

  repo.save(page("newest body", Mood::m1, Energy::e1, Source::typed, Hlc{300, 0, "devA"}));

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page_revision WHERE user_id = '" + kUser +
                   "'")[0].as<int>(),
           1);
  CHECK_EQ(w.exec1("SELECT body FROM journal_page_revision WHERE user_id = '" + kUser +
                   "'")[0].as<std::string>(),
           std::string("newer body"));
}

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

// The server serves every request on a drogon WORKER THREAD; this runs the same read on a fresh worker thread.
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
