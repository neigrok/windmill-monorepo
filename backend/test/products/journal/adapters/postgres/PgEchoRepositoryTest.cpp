#include "products/journal/adapters/postgres/PgEchoRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

// Opt-in integration test: it needs a live local Postgres with the schema applied. It runs only
// when WM_PG_TEST is set — otherwise every case here reports `skip`, which the run summary counts
// as skipped and never as passed (RUNNING.md §7 has the invocation). It seeds its own rows, so it
// is fully self-contained. It exists for the four things a fake cannot prove — that the anchoring
// hint is counted against the body Postgres actually holds, that the corpus count is the SQL's own
// idea of a written page, that one statement retires a whole panel on exactly the content hashes
// the pair-level door writes, and that a signal's score and curator version are copied off the echo
// row by the INSERT itself rather than by a second implementation of the same idea.
//
// Spans and echoes are planted THROUGH the repository rather than by hand, so the digests under
// every dismissal are the ones production computes and never a second implementation of them.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kMine = "22222222-2222-2222-2222-222222222222";
const std::string kTheirs = "33333333-3333-3333-3333-333333333333";

const std::string kLine = "i don't know what to do about any of it.";
const std::string kTrigger = "i still don't know what to do about it.";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  for (const std::string& user : {kMine, kTheirs}) {
    w.exec("INSERT INTO users (id, email) VALUES ('" + user + "', 'echo-" + user.substr(0, 4) +
           "@example.com') ON CONFLICT (id) DO NOTHING");
    // journal_page_curation is on this list because a page's derivation stamps outlive the page:
    // leave one behind and the next case's brand-new page is already "derived", which is exactly
    // the silent cross-case leak a due-page test cannot survive.
    for (const std::string& table : {"journal_echo_signal", "journal_echo_offer_dismissal",
                                     "journal_echo_dismissal", "journal_echo", "journal_span",
                                     "journal_page_curation", "journal_page"})
      w.exec("DELETE FROM " + table + " WHERE user_id = '" + user + "'");
  }
  w.commit();
}

void writePage(const std::string& user, const std::string& day, const std::string& body) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
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

int countOf(const std::string& sql) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  // exec1 (not query_value) so this compiles on the CI's pinned libpqxx 7.x as well as mac's 8.x.
  return w.exec1("SELECT count(*)::int FROM " + sql)[0].as<int>();
}

int signalsFor(const std::string& user) {
  return countOf("journal_echo_signal WHERE user_id = '" + user + "'");
}
}

// The gap this hint closes, against a real body. The match page says the same sentence twice and
// the echo points at the SECOND one; without a hint the client can only search, and it lands on
// the first.
TEST(pg_echo_a_repeated_passage_carries_the_occurrence_it_is) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};

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
  REQUIRE_EQ(echoes.size(), std::size_t{1});
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
  PgEchoRepository repo{pgTestPool()};

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
  REQUIRE_EQ(echoes.size(), std::size_t{1});
  CHECK_EQ(echoes[0].matchOccurrenceHint, 1);
}

// A hint the server cannot stand behind is not offered: the body moved under the passage, so there
// is no occurrence to name and the client goes back to searching by text.
TEST(pg_echo_a_body_edited_under_a_passage_offers_no_hint) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
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

  PgEchoRepository repo{pgTestPool()};
  CHECK_EQ(repo.pagesWritten(UserId{kMine}), 2);
  CHECK_EQ(repo.pagesWritten(UserId{kTheirs}), 1);
}

// The live path's opening move, against the real three-way condition. A page nobody has derived is
// owed one; the page the writer just saved is owed one; a page already derived against this body
// and this corpus is owed nothing, and that last answer is what makes a debounced second save free.
TEST(pg_echo_one_named_page_is_owed_a_derivation_on_the_same_three_conditions_the_shelf_is) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string day = "2026-05-01";
  writePage(kMine, day, "wrote a little.");
  PgEchoRepository repo{pgTestPool()};
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("UPDATE journal_page SET stamp_ms = 500 WHERE user_id = $1::uuid AND day = $2::date",
                  kMine, day);
    w.commit();
  }

  // Never derived.
  std::optional<DuePage> owed = repo.duePage(UserId{kMine}, LocalDate{day}, 0);
  REQUIRE(owed.has_value());
  CHECK_EQ(owed->body, std::string("wrote a little."));
  CHECK_EQ(owed->bodyStampMs, std::uint64_t{500});
  CHECK_EQ(owed->attempts, 0);

  // Derived against this body and this corpus: nothing owed.
  repo.recordCuration(UserId{kMine}, LocalDate{day}, CurationOutcome{CurationStatus::ok, 500, 9, ""});
  CHECK(!repo.duePage(UserId{kMine}, LocalDate{day}, 9).has_value());

  // The corpus moved under it — the backfill case, and the reason the repair pass still exists.
  CHECK(repo.duePage(UserId{kMine}, LocalDate{day}, 10).has_value());

  // A day nobody has written on is not a page, and another account's day is not this one's.
  CHECK(!repo.duePage(UserId{kMine}, LocalDate{"2026-05-02"}, 0).has_value());
  CHECK(!repo.duePage(UserId{kTheirs}, LocalDate{day}, 0).has_value());
}

// A failed curate leaves both stamps where they were, so the page comes back as owed — the one rule
// that keeps a vendor blip from costing a page its echoes permanently.
TEST(pg_echo_a_failed_curate_leaves_the_named_page_owed) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string day = "2026-05-01";
  writePage(kMine, day, "wrote a little.");
  PgEchoRepository repo{pgTestPool()};

  repo.recordCuration(UserId{kMine}, LocalDate{day},
                      CurationOutcome{CurationStatus::rateLimited, 500, 9, "rate_limited"});
  std::optional<DuePage> owed = repo.duePage(UserId{kMine}, LocalDate{day}, 9);
  REQUIRE(owed.has_value());
  CHECK_EQ(owed->attempts, 1);
}

// The one failure that finishes the page. Both stamps advance, so neither the next sweep nor a
// corpus that moves under it asks the vendor about this body again — only the writer editing it can.
TEST(pg_echo_a_refused_curate_settles_the_page_and_a_moving_corpus_does_not_reopen_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string day = "2026-05-01";
  writePage(kMine, day, "wrote a little.");
  PgEchoRepository repo{pgTestPool()};
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("UPDATE journal_page SET stamp_ms = 500 WHERE user_id = $1::uuid AND day = $2::date",
                  kMine, day);
    w.commit();
  }

  repo.recordCuration(UserId{kMine}, LocalDate{day},
                      CurationOutcome{CurationStatus::refused, 500, 9, "refused"});
  CHECK(!repo.duePage(UserId{kMine}, LocalDate{day}, 9).has_value());
  CHECK(!repo.duePage(UserId{kMine}, LocalDate{day}, 10).has_value());

  // The row still says what happened, and says it without counting a retry that will never come.
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    pqxx::result rows = w.exec_params(
        "SELECT status, attempts, last_error FROM journal_page_curation "
        "WHERE user_id = $1::uuid AND day = $2::date",
        kMine, day);
    REQUIRE_EQ(rows.size(), std::size_t{1});
    CHECK_EQ(rows[0]["status"].as<std::string>(), std::string("refused"));
    CHECK_EQ(rows[0]["attempts"].as<int>(), 0);
    CHECK_EQ(rows[0]["last_error"].as<std::string>(), std::string("refused"));
  }

  // The writer edits it: different text, and a fair thing to ask about again.
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("UPDATE journal_page SET stamp_ms = 900 WHERE user_id = $1::uuid AND day = $2::date",
                  kMine, day);
    w.commit();
  }
  CHECK(repo.duePage(UserId{kMine}, LocalDate{day}, 9).has_value());
}

// Storage hands back what it stored, minted identities and all. This is what a warm corpus splices
// on, so an id it invented has to travel out of the INSERT rather than be read for a second time.
TEST(pg_echo_replacing_a_pages_spans_hands_back_the_identities_it_minted) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const std::string day = "2026-05-01";
  writePage(kMine, day, kLine + " " + kTrigger);
  PgEchoRepository repo{pgTestPool()};

  const std::vector<Vectored> stored = repo.replaceSpans(
      UserId{kMine}, LocalDate{day},
      {span(0, 0, 0, kLine), span(4242, 1, static_cast<int>(kLine.size()) + 1, kTrigger)}, "v1", 1);

  REQUIRE_EQ(stored.size(), std::size_t{2});
  CHECK(stored[0].spanId != 0);            // minted by the sequence, and it came back
  CHECK_EQ(stored[0].text, kLine);
  CHECK(stored[0].day == LocalDate{day});
  CHECK_EQ(stored[1].spanId, std::int64_t{4242});   // carried forward, recorded as chosen
  CHECK_EQ(stored[1].text, kTrigger);

  // And it is the same set, in the same order, that a cold corpus read serves.
  const std::vector<Vectored> cold = repo.corpusOf(UserId{kMine}, "v1");
  REQUIRE_EQ(cold.size(), std::size_t{2});
  CHECK_EQ(cold[0].spanId, stored[0].spanId);
  CHECK_EQ(cold[1].spanId, stored[1].spanId);
}

// One statement retires the panel, and pressing "Not useful" twice is the same as pressing it once.
TEST(pg_echo_dismissing_a_page_retires_every_pairing_and_repeats_harmlessly) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{3});

  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});
  repo.dismissPage(UserId{kMine}, LocalDate{"2026-05-01"});

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{0});
  CHECK_EQ(countOf("journal_echo_dismissal WHERE user_id = '" + kMine + "'"), 3);   // not six
}

TEST(pg_echo_dismissing_a_page_leaves_another_day_and_another_account_untouched) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
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
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  CHECK_EQ(repo.retiredOffers(UserId{kMine}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"}).size(),
           std::size_t{0});

  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});
  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});   // declining twice is declining once

  CHECK_EQ(echoesOn(repo, kMine, "2026-05-01").size(), std::size_t{3});   // not one echo lost
  std::vector<LocalDate> retired =
      repo.retiredOffers(UserId{kMine}, LocalDate{"2026-01-01"}, LocalDate{"2026-12-31"});
  REQUIRE_EQ(retired.size(), std::size_t{1});
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
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kMine, "2026-06-01", 200);
  plantPanel(repo, kTheirs, "2026-05-01", 300);

  repo.dismissOffer(UserId{kMine}, LocalDate{"2026-05-01"});

  std::vector<LocalDate> mine =
      repo.retiredOffers(UserId{kMine}, LocalDate{"0001-01-01"}, LocalDate{"9999-12-31"});
  REQUIRE_EQ(mine.size(), std::size_t{1});
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
  PgEchoRepository repo{pgTestPool()};
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
  PgEchoRepository repo{pgTestPool()};
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

// ── The quality signals ─────────────────────────────────────────────────────────────────────────
// The columns that make journal_echo_signal a dataset rather than a tally are copied off the echo
// row by the INSERT itself, which is precisely the part a fake cannot prove.

TEST(pg_echo_a_useful_mark_carries_the_score_and_the_curator_that_produced_the_pairing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);

  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"},
                    EchoSignal::useful);

  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  pqxx::result rows = w.exec_params(
      "SELECT trigger_day::text AS trigger_day, trigger_span_id, match_day::text AS match_day, "
      "match_span_id, kind, cosine, relation, curator_version "
      "FROM journal_echo_signal WHERE user_id = $1::uuid",
      kMine);
  REQUIRE_EQ(rows.size(), std::size_t{1});
  CHECK_EQ(rows[0]["trigger_day"].as<std::string>(), std::string("2026-05-01"));
  CHECK_EQ(rows[0]["trigger_span_id"].as<std::int64_t>(), std::int64_t{100});
  CHECK_EQ(rows[0]["match_day"].as<std::string>(), std::string("2024-02-01"));
  CHECK_EQ(rows[0]["match_span_id"].as<std::int64_t>(), std::int64_t{102});
  CHECK_EQ(rows[0]["kind"].as<std::string>(), std::string("useful"));
  CHECK_EQ(rows[0]["cosine"].as<float>(), 0.8f);
  CHECK_EQ(rows[0]["relation"].as<float>(), 0.9f);
  CHECK_EQ(rows[0]["curator_version"].as<std::string>(), std::string("pg-test-v1"));
}

// The answer comes back on the read, which is the whole reason it is server-side: a mark made on a
// laptop that a phone cannot see is a mark the phone asks for a second time.
TEST(pg_echo_the_read_says_which_pairings_the_reader_called_useful) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  for (const EchoView& echo : echoesOn(repo, kMine, "2026-05-01")) CHECK(!echo.markedUseful);

  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"},
                    EchoSignal::useful);

  int marked = 0;
  for (const EchoView& echo : echoesOn(repo, kMine, "2026-05-01")) {
    if (!echo.markedUseful) continue;
    ++marked;
    CHECK_EQ(echo.matchDay.iso(), std::string("2024-02-01"));
  }
  CHECK_EQ(marked, 1);
}

// Only 'useful' is an endorsement. Opening the older page is a weaker label and a dismissal is the
// opposite one, and neither may come back on the read as a mark the reader never made.
TEST(pg_echo_opening_and_dismissing_are_not_read_back_as_useful) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);

  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-01-01"},
                    EchoSignal::opened);
  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"},
                    EchoSignal::notUseful);

  CHECK_EQ(signalsFor(kMine), 2);
  for (const EchoView& echo : echoesOn(repo, kMine, "2026-05-01")) CHECK(!echo.markedUseful);
}

// One pairing can carry all three answers — opened on Monday, useful on Tuesday, retired in March —
// so kind is in the primary key. Pressing any one of them twice is still one row.
TEST(pg_echo_the_three_answers_are_three_rows_and_each_repeats_harmlessly) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);

  for (int again = 0; again < 2; ++again)
    for (const EchoSignal kind : {EchoSignal::opened, EchoSignal::useful, EchoSignal::notUseful})
      repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-03-01"}, kind);

  CHECK_EQ(signalsFor(kMine), 3);
}

// A pairing this account never had is no row at all, so a forged day buys a caller an empty insert
// rather than a signal about somebody else's page.
TEST(pg_echo_a_signal_about_a_pairing_that_never_existed_writes_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kTheirs, "2026-05-01", 300);

  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2023-09-09"},
                    EchoSignal::useful);
  repo.recordSignal(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-01-01"},
                    EchoSignal::useful);

  CHECK_EQ(signalsFor(kMine), 1);
  CHECK_EQ(signalsFor(kTheirs), 0);   // the same day in another account is untouched
  for (const EchoView& echo : echoesOn(repo, kTheirs, "2026-05-01")) CHECK(!echo.markedUseful);
}

// The panel-level "Not useful" is one tap about every pairing on the page, so it records one
// judgement about each — and repeating it is still three rows.
TEST(pg_echo_a_page_signal_records_one_row_per_pairing_and_repeats_harmlessly) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kMine, "2026-06-01", 200);

  repo.recordPageSignal(UserId{kMine}, LocalDate{"2026-05-01"}, EchoSignal::notUseful);
  repo.recordPageSignal(UserId{kMine}, LocalDate{"2026-05-01"}, EchoSignal::notUseful);

  CHECK_EQ(signalsFor(kMine), 3);
  CHECK_EQ(countOf("journal_echo_signal WHERE user_id = '" + kMine +
                   "' AND kind = 'not_useful' AND trigger_day = '2026-05-01'"),
           3);
  CHECK_EQ(countOf("journal_echo_signal WHERE user_id = '" + kMine +
                   "' AND trigger_day = '2026-06-01'"),
           0);   // the other page was not part of the tap
}

// The pair-level door, now one statement. It retires exactly the pairing it names, on the same
// content hashes the panel door writes — the guarantee that must not regress is that what it
// retires never comes back.
TEST(pg_echo_dismissing_one_pairing_retires_that_one_and_leaves_the_panel_standing) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  plantPanel(repo, kTheirs, "2026-05-01", 300);

  repo.dismissPair(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"});
  repo.dismissPair(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"});

  const std::vector<EchoView> left = echoesOn(repo, kMine, "2026-05-01");
  REQUIRE_EQ(left.size(), std::size_t{2});
  CHECK_EQ(left[0].matchDay.iso(), std::string("2024-01-01"));
  CHECK_EQ(left[1].matchDay.iso(), std::string("2024-03-01"));
  CHECK_EQ(countOf("journal_echo_dismissal WHERE user_id = '" + kMine + "'"), 1);   // not two
  CHECK_EQ(echoesOn(repo, kTheirs, "2026-05-01").size(), std::size_t{3});
}

// Keyed on what the two passages SAY. The night re-derives the page with brand new span ids and
// every offset shifted, and the pairing the reader retired must stay retired.
TEST(pg_echo_a_dismissed_pairing_stays_dismissed_when_its_passages_move) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgEchoRepository repo{pgTestPool()};
  plantPanel(repo, kMine, "2026-05-01", 100);
  repo.dismissPair(UserId{kMine}, LocalDate{"2026-05-01"}, LocalDate{"2024-02-01"});

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

  const std::vector<EchoView> left = echoesOn(repo, kMine, "2026-05-01");
  REQUIRE_EQ(left.size(), std::size_t{2});
  CHECK_EQ(left[0].matchDay.iso(), std::string("2024-01-01"));
  CHECK_EQ(left[1].matchDay.iso(), std::string("2024-03-01"));
}
