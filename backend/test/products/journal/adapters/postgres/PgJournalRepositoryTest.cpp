#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "products/journal/application/PageService.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <optional>
#include <string>
#include <thread>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every case reports skip. It seeds its own user row.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kUser = "11111111-1111-1111-1111-111111111111";

struct JournalEngineMode {
  std::optional<std::string> previous;
  explicit JournalEngineMode(bool enabled) {
    if (const char* value = std::getenv("JOURNAL_ENGINE_WRITES")) previous = value;
    setenv("JOURNAL_ENGINE_WRITES", enabled ? "1" : "0", 1);
  }
  ~JournalEngineMode() {
    if (previous) setenv("JOURNAL_ENGINE_WRITES", previous->c_str(), 1);
    else unsetenv("JOURNAL_ENGINE_WRITES");
  }
};

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kUser + "', 'journal-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM journal_page WHERE user_id = '" + kUser + "'");
  w.exec("DELETE FROM journal_page_revision WHERE user_id = '" + kUser + "'");
  w.commit();
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

// The row the engine's page store keeps for a page, written straight in: these cases are about the reads.
void stored(const Page& incoming) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  pqxx::params row{incoming.user.str(), incoming.day.iso(), incoming.body};
  if (incoming.mood) row.append(incoming.mood->value()); else row.append();
  if (incoming.energy) row.append(incoming.energy->value()); else row.append();
  row.append(toString(incoming.source));
  row.append(static_cast<long long>(incoming.stamp.physicalMs));
  row.append(static_cast<long long>(incoming.stamp.counter));
  row.append(incoming.stamp.actor);
  w.exec("INSERT INTO journal_page (user_id, day, body, mood, energy, source, stamp_ms, stamp_counter, stamp_actor) "
         "VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9) "
         "ON CONFLICT (user_id, day) DO UPDATE SET body = excluded.body, mood = excluded.mood, energy = excluded.energy, "
         "source = excluded.source, stamp_ms = excluded.stamp_ms, stamp_counter = excluded.stamp_counter, "
         "stamp_actor = excluded.stamp_actor",
         row);
  w.commit();
}
}

TEST(pg_journal_load_reads_every_field_of_the_stored_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  stored(page("round trip", Score{3}, Score{8}, Source::spoken, Hlc{500, 0, "devZ"}));

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

// Equal stamps tie-break on the day, so a page of the feed never splits a cohort differently from the next read.
TEST(pg_journal_since_orders_equal_stamps_by_day) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  JournalEngineMode on(true);
  reset();
  PgJournalRepository repo{pgTestPool()};
  const UserId user(kUser);
  for (const char* day : {"2026-07-03", "2026-07-02", "2026-07-01"}) {
    Page incoming(user, LocalDate(day));
    incoming.body = day;
    incoming.stamp = Hlc{500, 2, "same"};
    stored(incoming);
  }
  for (int mutation = 0; mutation < 2; ++mutation) {
    for (const int limit : {1, 2, 500}) {
      const auto admitted = repo.since(user, Hlc{0, 0, ""}, limit);
      REQUIRE_EQ(admitted.size(), static_cast<std::size_t>(std::min(limit, 3)));
      for (std::size_t index = 0; index < admitted.size(); ++index)
        CHECK_EQ(admitted[index].day.iso(), "2026-07-0" + std::to_string(index + 1));
    }
    CHECK(repo.since(user, Hlc{500, 2, "same"}, 500).empty());
    PgLease lease{*pgTestPool()};
    pqxx::work sql{*lease};
    sql.exec("update journal_page set updated_at=now() where user_id=$1::uuid and day='2026-07-01'", pqxx::params{kUser});
    sql.commit();
  }
}

// 0 is an answer and null is silence, and the read has to keep them apart.
TEST(pg_journal_keeps_a_stored_zero_apart_from_an_unanswered_scale) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};

  stored(page("the floor", Score{0}, Score{0}, Source::typed, Hlc{100, 0, "devA"}));

  std::optional<Page> floored = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(floored.has_value());
  CHECK_EQ(floored->mood, std::optional<Score>{Score{0}});
  CHECK_EQ(floored->energy, std::optional<Score>{Score{0}});

  stored(page("cleared", std::nullopt, std::nullopt, Source::typed, Hlc{200, 0, "devA"}));

  std::optional<Page> cleared = repo.load(UserId{kUser}, LocalDate{"2026-07-27"});
  REQUIRE(cleared.has_value());
  CHECK_EQ(cleared->mood, std::optional<Score>{});
  CHECK_EQ(cleared->energy, std::optional<Score>{});

  // and a null on one scale does not drag the other down with it
  stored(page("half", Score{0}, std::nullopt, Source::typed, Hlc{300, 0, "devA"}));
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

TEST(pg_journal_through_pageservice_reads_the_body) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgJournalRepository repo{pgTestPool()};
  PageService service{repo};

  stored(page("via the service", Score{5}, Score{5}, Source::typed, Hlc{300, 0, "devQ"}));
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
  stored(page("off-thread", Score{3}, Score{2}, Source::spoken, Hlc{400, 0, "devW"}));

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
