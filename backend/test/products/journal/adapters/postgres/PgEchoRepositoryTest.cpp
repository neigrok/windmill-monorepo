#include "products/journal/adapters/postgres/PgEchoRepository.h"

#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <string>
#include <vector>

// Opt-in integration test: it needs a live local Postgres with the schema applied. It runs only
// when WM_PG_TEST is set — otherwise every case here reports `skip`, which the run summary counts
// as skipped and never as passed (RUNNING.md §7 has the invocation). It seeds its own rows, so it
// is fully self-contained. It exists for the three things a fake cannot prove — that the
// anchoring hint is counted against the body Postgres actually holds, that the corpus count is the
// SQL's own idea of a written page, and that one statement retires a whole panel on exactly the
// content hashes the pair-level door writes.
//
// Spans and echoes are planted THROUGH the repository rather than by hand, so the digests under
// every dismissal are the ones production computes and never a second implementation of them.
using namespace wm;

namespace {
std::string connString() {
  const char* url = std::getenv("DATABASE_URL");
  return url ? url : "postgresql://localhost/windmill";
}
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kMine = "22222222-2222-2222-2222-222222222222";
const std::string kTheirs = "33333333-3333-3333-3333-333333333333";

const std::string kLine = "i don't know what to do about any of it.";
const std::string kTrigger = "i still don't know what to do about it.";

void reset() {
  pqxx::connection c{connString()};
  pqxx::work w{c};
  for (const std::string& user : {kMine, kTheirs}) {
    w.exec("INSERT INTO users (id, email) VALUES ('" + user + "', 'echo-" + user.substr(0, 4) +
           "@example.com') ON CONFLICT (id) DO NOTHING");
    for (const std::string& table : {"journal_echo_offer_dismissal", "journal_echo_dismissal",
                                     "journal_echo", "journal_span", "journal_page"})
      w.exec("DELETE FROM " + table + " WHERE user_id = '" + user + "'");
  }
  w.commit();
}

void writePage(const std::string& user, const std::string& day, const std::string& body) {
  pqxx::connection c{connString()};
  pqxx::work w{c};
  w.exec_params("INSERT INTO journal_page (user_id, day, body) VALUES ($1::uuid, $2::date, $3) "
                "ON CONFLICT (user_id, day) DO UPDATE SET body = EXCLUDED.body",
                user, day, body);
  w.commit();
}

SpanWrite span(std::int64_t spanId, int ord, int lo, const std::string& text) {
  return SpanWrite{spanId, Passage{ord, lo, lo + static_cast<int>(text.size()), text}, {}};
}

EchoRow echoRow(std::int64_t triggerSpanId, const std::string& matchDay,
                std::int64_t matchSpanId) {
  return EchoRow{triggerSpanId, LocalDate{matchDay}, matchSpanId, 0.8f, 0.9f, true};
}

// One panel: tonight's page reaching into three older ones. Every passage names its owner and its
// day, because dismissal is keyed on CONTENT — two accounts writing the identical sentence would
// otherwise be indistinguishable to a test that means to prove they are separate.
void plantPanel(PgEchoRepository& repo, const std::string& user, const std::string& triggerDay,
                std::int64_t base) {
  const std::string tag = " (" + user.substr(0, 4) + " " + triggerDay + ")";
  writePage(user, triggerDay, kTrigger + tag);
  repo.replaceSpans(UserId{user}, LocalDate{triggerDay}, {span(base, 0, 0, kTrigger + tag)}, "v1", 1);

  CuratedEchoes curated;
  curated.curatorVersion = "pg-test-v1";
  for (int at = 1; at <= 3; ++at) {
    const std::string matchDay = "2024-0" + std::to_string(at) + "-01";
    const std::string text = kLine + tag + " " + std::to_string(at);
    writePage(user, matchDay, text);
    repo.replaceSpans(UserId{user}, LocalDate{matchDay}, {span(base + at, 0, 0, text)}, "v1", 1);
    curated.rows.push_back(echoRow(base, matchDay, base + at));
  }
  repo.replaceEchoes(UserId{user}, LocalDate{triggerDay}, curated);
}

std::vector<EchoView> echoesOn(PgEchoRepository& repo, const std::string& user,
                               const std::string& day) {
  return repo.echoesFor(UserId{user}, LocalDate{day}, LocalDate{day});
}
}

// The gap this hint closes, against a real body. The match page says the same sentence twice and
// the echo points at the SECOND one; without a hint the client can only search, and it lands on
// the first.
TEST(pg_echo_a_repeated_passage_carries_the_occurrence_it_is) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};

  const std::string body = kLine + "\nthe day was long and grey and then it was over.\n" + kLine;
  const int second = static_cast<int>(body.rfind(kLine));
  writePage(kMine, "2026-05-01", kTrigger);
  writePage(kMine, "2024-01-01", body);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2026-05-01"}, {span(21, 0, 0, kTrigger)}, "v1", 1);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2024-01-01"},
                    {span(11, 0, 0, kLine), span(12, 1, second, kLine)}, "v1", 1);

  CuratedEchoes curated;
  curated.curatorVersion = "pg-test-v1";
  curated.rows.push_back(echoRow(21, "2024-01-01", 12));
  repo.replaceEchoes(UserId{kMine}, LocalDate{"2026-05-01"}, curated);

  const std::vector<EchoView> echoes = echoesOn(repo, kMine, "2026-05-01");
  CHECK_EQ(echoes.size(), std::size_t{1});
  CHECK_EQ(echoes[0].matchText, kLine);
  CHECK_EQ(echoes[0].matchOccurrenceHint, 1);   // the second, not the first
  CHECK_EQ(echoes[0].daysEarlier, 851);
}

// Why it is an occurrence index and not the offset storage holds. The second passage here starts
// 27 BYTES into the body and 23 UTF-16 code units into it; either number sent raw puts the
// browser's slice inside a word. The occurrence index is 1 in every encoding anyone counts in.
TEST(pg_echo_the_hint_is_the_one_number_both_sides_agree_on) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};

  const std::string accented = "café. déjà vu. touché.";
  const std::string body = accented + "\n" + accented;
  const int second = static_cast<int>(body.rfind(accented));
  CHECK_EQ(second, 27);   // bytes; the browser would count 23 code units to the same character

  writePage(kMine, "2026-05-01", kTrigger);
  writePage(kMine, "2024-01-01", body);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2026-05-01"}, {span(21, 0, 0, kTrigger)}, "v1", 1);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2024-01-01"},
                    {span(11, 0, 0, accented), span(12, 1, second, accented)}, "v1", 1);

  CuratedEchoes curated;
  curated.curatorVersion = "pg-test-v1";
  curated.rows.push_back(echoRow(21, "2024-01-01", 12));
  repo.replaceEchoes(UserId{kMine}, LocalDate{"2026-05-01"}, curated);

  const std::vector<EchoView> echoes = echoesOn(repo, kMine, "2026-05-01");
  CHECK_EQ(echoes.size(), std::size_t{1});
  CHECK_EQ(echoes[0].matchOccurrenceHint, 1);
}

// A hint the server cannot stand behind is not offered: the body moved under the passage, so there
// is no occurrence to name and the client goes back to searching by text.
TEST(pg_echo_a_body_edited_under_a_passage_offers_no_hint) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);

  const std::string moved = kLine + " (2222 2026-05-01) 1";
  writePage(kMine, "2024-01-01", "a line inserted above it.\n" + moved);

  int hinted = 0;
  int unhinted = 0;
  for (const EchoView& echo : echoesOn(repo, kMine, "2026-05-01")) {
    if (echo.matchOccurrenceHint < 0) ++unhinted;
    if (echo.matchOccurrenceHint == 0) ++hinted;
  }
  CHECK_EQ(unhinted, 1);   // only the page that was edited
  CHECK_EQ(hinted, 2);
}

// The ~20-page corpus floor, counted the way SQL counts it: a page holding only whitespace is one
// the reader opened, not one they wrote.
TEST(pg_echo_pages_written_counts_pages_with_words_on_them) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  writePage(kMine, "2026-05-01", "wrote a little.");
  writePage(kMine, "2026-05-02", "wrote a little more.");
  writePage(kMine, "2026-05-03", "   \n\t  ");
  writePage(kMine, "2026-05-04", "");
  writePage(kTheirs, "2026-05-01", "not mine.");

  PgEchoRepository repo{connString()};
  CHECK_EQ(repo.pagesWritten(UserId{kMine}), 2);
  CHECK_EQ(repo.pagesWritten(UserId{kTheirs}), 1);
}

// One statement retires the panel, and pressing "Not useful" twice is the same as pressing it once.
TEST(pg_echo_dismissing_a_page_retires_every_pairing_and_repeats_harmlessly) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{3});

  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});
  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{0});
  pqxx::connection c{connString()};
  pqxx::work w{c};
  // exec1 (not query_value) so this compiles on the CI's pinned libpqxx 7.x as well as mac's 8.x.
  CHECK_EQ(w.exec1("SELECT count(*)::int FROM journal_echo_dismissal WHERE user_id = '" + kMine +
                   "'")[0].as<int>(),
           3);   // three rows, not six
}

TEST(pg_echo_dismissing_a_page_leaves_another_day_and_another_account_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kMine, "2026-06-01", 200);
  plantPanel(repo, kTheirs, "2026-05-01", 300);

  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{0});
  CHECK_EQ(echoesOn(repo, kMine, "2026-06-01").size(), std::size_t{3});
  CHECK_EQ(echoesOn(repo, kTheirs, "2026-05-01").size(), std::size_t{3});   // a forged day reaches nobody else
}

// "Not now" retires the ASKING and nothing else — the echoes on that page are still there — and it
// survives a re-derivation, which is the whole reason it keys on the day rather than on a hash of
// text that is about to move.
TEST(pg_echo_declining_the_offer_keeps_every_echo_and_outlives_a_re_derivation) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  CHECK_EQ(repo.retiredOffers(UserId{kMine}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"}).size(),
           std::size_t{0});

  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});
  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});   // declining twice is declining once

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{3});   // not one echo lost
  std::vector<LocalDate> retired =
      repo.retiredOffers(UserId{kMine}, LocalDate{"2026-01-01"}, LocalDate{"2026-12-31"});
  CHECK_EQ(retired.size(), std::size_t{1});
  CHECK_EQ(retired[0].iso(), std::string("2026-05-01"));

  // The page is re-derived from scratch: new span ids, new offsets, every sentence rewritten.
  const std::string rewritten = "a completely different sentence tonight, nothing like the last.";
  writePage(kMine, "2026-05-01", rewritten);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2026-05-01"}, {span(900, 0, 0, rewritten)}, "v1", 2);

  CHECK_EQ(repo.retiredOffers(UserId{kMine}, LocalDate{"2026-01-01"}, LocalDate{"2026-12-31"}).size(),
           std::size_t{1});   // the reader still said no to being asked here
}

TEST(pg_echo_declining_one_offer_leaves_another_day_and_another_account_asking) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kMine, "2026-06-01", 200);
  plantPanel(repo, kTheirs, "2026-05-01", 300);

  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});

  std::vector<LocalDate> mine =
      repo.retiredOffers(UserId{kMine}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"});
  CHECK_EQ(mine.size(), std::size_t{1});
  CHECK_EQ(mine[0].iso(), std::string("2026-05-01"));
  CHECK_EQ(repo.retiredOffers(UserId{kTheirs}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"}).size(),
           std::size_t{0});
  // and the window is honoured, so a read of June alone never sees May's answer
  CHECK_EQ(repo.retiredOffers(UserId{kMine}, LocalDate{"2026-06-01"}, LocalDate{"2026-06-30"}).size(),
           std::size_t{0});
}

// The two answers are independent: retiring a page's echoes is not an answer to the offer.
TEST(pg_echo_retiring_a_pages_echoes_writes_no_offer_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);

  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});

  CHECK_EQ(repo.retiredOffers(UserId{kMine}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"}).size(),
           std::size_t{0});
}

// Keyed on what the passages SAY. The night re-derives the page with brand new span ids and every
// offset on it shifted; the dismissal has to hold anyway, because an echo the reader retired
// coming back is the one failure this feature cannot afford.
TEST(pg_echo_a_dismissed_page_stays_dismissed_when_its_passages_move) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{connString()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});

  const std::string tag = " (2222 2026-05-01)";
  const std::string opening = "a new opening line.\n";
  writePage(kMine, "2026-05-01", opening + kTrigger + tag);
  repo.replaceSpans(UserId{kMine}, LocalDate{"2026-05-01"},
                    {span(900, 0, static_cast<int>(opening.size()), kTrigger + tag)}, "v1", 2);

  CuratedEchoes curated;
  curated.curatorVersion = "pg-test-v2";
  for (int at = 1; at <= 3; ++at) {
    const std::string matchDay = "2024-0" + std::to_string(at) + "-01";
    const std::string text = kLine + tag + " " + std::to_string(at);
    repo.replaceSpans(UserId{kMine}, LocalDate{matchDay}, {span(900 + at, 0, 0, text)}, "v1", 2);
    curated.rows.push_back(echoRow(900, matchDay, 900 + at));
  }
  repo.replaceEchoes(UserId{kMine}, LocalDate{"2026-05-01"}, curated);

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{0});
}
