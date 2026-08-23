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

Page page(const std::string& body, std::optional<Score> mood, std::optional<Score> energy,
          Source source, const Hlc& stamp) {
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

  CHECK_EQ(repo.save(page("round trip", Score{3}, Score{8}, Source::spoken, Hlc{500, 0, "devZ"})),
           PageWrite::stored);

  std::optional<Page> got = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(got.has_value());
  CHECK_EQ(got->day.iso(), std::string("2026-07-27"));
  CHECK_EQ(got->body, std::string("round trip"));
  CHECK_EQ(got->mood, std::optional<Score>{Score{3}});
  CHECK_EQ(got->energy, std::optional<Score>{Score{8}});
  CHECK(got->source == Source::spoken);
  CHECK_EQ(got->stamp.physicalMs, static_cast<std::uint64_t>(500));
  CHECK_EQ(got->stamp.actor, std::string("devZ"));
}

// 0 is an answer and null is silence, and the column has to keep them apart on both legs.
TEST(pg_journal_keeps_a_stored_zero_apart_from_an_unanswered_scale) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  CHECK_EQ(repo.save(page("the floor", Score{0}, Score{0}, Source::typed, Hlc{100, 0, "devA"})),
           PageWrite::stored);

  std::optional<Page> floored = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(floored.has_value());
  CHECK_EQ(floored->mood, std::optional<Score>{Score{0}});
  CHECK_EQ(floored->energy, std::optional<Score>{Score{0}});
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page WHERE user_id = '" + kUser +
                     "' AND mood = 0 AND energy = 0")[0].as<int>(),
             1);
    CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page WHERE user_id = '" + kUser +
                     "' AND mood IS NULL")[0].as<int>(),
             0);
  }

  CHECK_EQ(repo.save(page("cleared", std::nullopt, std::nullopt, Source::typed, Hlc{200, 0, "devA"})),
           PageWrite::superseded);

  std::optional<Page> cleared = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(cleared.has_value());
  CHECK_EQ(cleared->mood, std::optional<Score>{});
  CHECK_EQ(cleared->energy, std::optional<Score>{});
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_page WHERE user_id = '" + kUser +
                     "' AND mood IS NULL AND energy IS NULL")[0].as<int>(),
             1);
  }

  // and a null on one scale does not drag the other down with it
  CHECK_EQ(repo.save(page("half", Score{0}, std::nullopt, Source::typed, Hlc{300, 0, "devA"})),
           PageWrite::superseded);
  std::optional<Page> half = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(half.has_value());
  CHECK_EQ(half->mood, std::optional<Score>{Score{0}});
  CHECK_EQ(half->energy, std::optional<Score>{});
}

// The column the migration left behind: nullable, no default, and 0..10 is the whole of what it
// will hold. Asserted against the live database, not against the file that claims to define it.
TEST(pg_journal_scale_columns_are_nullable_and_bounded_to_the_new_range) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};

  pqxx::result shape = w.exec(
      "SELECT column_name, is_nullable, coalesce(column_default, '') AS def "
      "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'journal_page' "
      "AND column_name IN ('mood', 'energy') ORDER BY column_name");
  REQUIRE_EQ(shape.size(), 2u);
  CHECK_EQ(shape[0]["column_name"].as<std::string>(), std::string("energy"));
  CHECK_EQ(shape[0]["is_nullable"].as<std::string>(), std::string("YES"));
  CHECK_EQ(shape[0]["def"].as<std::string>(), std::string(""));
  CHECK_EQ(shape[1]["column_name"].as<std::string>(), std::string("mood"));
  CHECK_EQ(shape[1]["is_nullable"].as<std::string>(), std::string("YES"));
  CHECK_EQ(shape[1]["def"].as<std::string>(), std::string(""));

  CHECK_EQ(w.exec1("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                   "WHERE conrelid = 'journal_page'::regclass AND conname = 'journal_page_mood_check'")
               [0].as<std::string>(),
           std::string("CHECK (((mood >= 0) AND (mood <= 10)))"));
  CHECK_EQ(w.exec1("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                   "WHERE conrelid = 'journal_page'::regclass AND conname = 'journal_page_energy_check'")
               [0].as<std::string>(),
           std::string("CHECK (((energy >= 0) AND (energy <= 10)))"));
  w.commit();

  // Every step of the range lands, and the step past the ceiling is refused by the database.
  for (int step = 0; step <= 10; ++step) {
    PgLease accept{*pgTestPool()};
    pqxx::work insert{*accept};
    insert.exec("INSERT INTO journal_page (user_id, day, mood, energy) VALUES ('" + kUser + "', '2026-04-" +
                (step < 9 ? "0" : "") + std::to_string(step + 1) + "', " + std::to_string(step) + ", " +
                std::to_string(10 - step) + ")");
    insert.commit();
  }

  bool refusedEleven = false;
  try {
    PgLease reject{*pgTestPool()};
    pqxx::work insert{*reject};
    insert.exec("INSERT INTO journal_page (user_id, day, mood) VALUES ('" + kUser + "', '2026-05-01', 11)");
    insert.commit();
  } catch (const pqxx::check_violation&) {
    refusedEleven = true;
  }
  CHECK(refusedEleven);

  PgLease after{*pgTestPool()};
  pqxx::work count{*after};
  CHECK_EQ(count.exec1("SELECT count(*)::int FROM journal_page WHERE user_id = '" + kUser + "'")[0].as<int>(),
           11);
}

// A value the constraint would refuse today can still be sitting in a column that predates it. The
// reader narrows it to unanswered rather than failing a page load over storage.
TEST(pg_journal_narrows_an_out_of_range_stored_scale_to_unset) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec("ALTER TABLE journal_page DROP CONSTRAINT journal_page_mood_check");
    w.exec("ALTER TABLE journal_page DROP CONSTRAINT journal_page_energy_check");
    w.exec("INSERT INTO journal_page (user_id, day, body, mood, energy, source) VALUES ('" + kUser +
           "', '2026-07-27', 'typo', 42, -3, 'typed')");
    w.commit();
  }

  std::optional<Page> got = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});

  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec("DELETE FROM journal_page WHERE user_id = '" + kUser + "'");
    w.exec("ALTER TABLE journal_page ADD CONSTRAINT journal_page_mood_check CHECK (mood BETWEEN 0 AND 10)");
    w.exec("ALTER TABLE journal_page ADD CONSTRAINT journal_page_energy_check CHECK (energy BETWEEN 0 AND 10)");
    w.commit();
  }

  REQUIRE(got.has_value());
  CHECK_EQ(got->body, std::string("typo"));
  CHECK_EQ(got->mood, std::optional<Score>{});
  CHECK_EQ(got->energy, std::optional<Score>{});
}

TEST(pg_journal_lww_and_revision_trail) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  CHECK_EQ(repo.save(page("first light", Score{7}, Score{5}, Source::typed, Hlc{100, 0, "devA"})),
           PageWrite::stored);
  // an older stamp from another device loses and writes nothing
  CHECK_EQ(repo.save(page("stale", Score{1}, Score{2}, Source::typed, Hlc{50, 0, "devB"})),
           PageWrite::ignoredStale);
  // a newer stamp wins and supersedes
  CHECK_EQ(repo.save(page("clearer now", Score{9}, Score{8}, Source::spoken, Hlc{200, 0, "devB"})),
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
    repo.save(page("body " + std::to_string(write), Score{1}, Score{2}, Source::typed,
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
  repo.save(page("old body", Score{1}, Score{2}, Source::typed, Hlc{100, 0, "devA"}));
  repo.save(page("newer body", Score{1}, Score{2}, Source::typed, Hlc{200, 0, "devA"}));
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec("UPDATE journal_page_revision SET superseded_at = now() - interval '91 days' "
           "WHERE user_id = '" + kUser + "'");
    w.commit();
  }

  repo.save(page("newest body", Score{1}, Score{2}, Source::typed, Hlc{300, 0, "devA"}));

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

  service.write(page("via the service", Score{5}, Score{5}, Source::typed, Hlc{300, 0, "devQ"}));
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
  service.write(page("off-thread", Score{3}, Score{2}, Source::spoken, Hlc{400, 0, "devW"}));

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
