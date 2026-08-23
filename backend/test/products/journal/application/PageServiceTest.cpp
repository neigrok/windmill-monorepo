#include "products/journal/application/PageService.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <optional>

using namespace wm;
using namespace wm::fake;

namespace {
Page pageOn(std::string iso, std::string body, Hlc stamp) {
  return Page{uid(), ld(std::move(iso)), std::move(body), std::nullopt, std::nullopt, Source::typed,
              std::move(stamp), 0};
}
}

TEST(write_of_a_fresh_page_stores_and_returns_it) {
  FakeJournalRepository repo;
  PageService service(repo);

  Page fresh = pageOn("2026-07-27", "first light", hlc(100));
  WriteOutcome outcome = service.write(fresh);

  CHECK_EQ(outcome.result, PageWrite::stored);
  CHECK_EQ(outcome.page, fresh);
}

TEST(write_resolves_to_the_winning_body_regardless_of_arrival_order) {
  Page early = pageOn("2026-07-27", "hundred", hlc(100));
  Page stale = pageOn("2026-07-27", "fifty", hlc(50));
  Page late = pageOn("2026-07-27", "two hundred", hlc(200));

  // Arrival A: the winner arrives last — a fresh 100, an older 50 that loses, then a 200 that wins.
  {
    FakeJournalRepository repo;
    PageService service(repo);

    CHECK_EQ(service.write(early).result, PageWrite::stored);

    WriteOutcome lost = service.write(stale);
    CHECK_EQ(lost.result, PageWrite::ignoredStale);
    CHECK_EQ(lost.page, early);          // the loser is handed the body that actually won

    WriteOutcome won = service.write(late);
    CHECK_EQ(won.result, PageWrite::superseded);
    CHECK_EQ(won.page, late);

    CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>(late));
  }

  // Arrival B: the exact opposite order — 200 first, then 50, then 100. The hlc(200) body still wins.
  {
    FakeJournalRepository repo;
    PageService service(repo);

    CHECK_EQ(service.write(late).result, PageWrite::stored);
    CHECK_EQ(service.write(stale).result, PageWrite::ignoredStale);
    CHECK_EQ(service.write(early).result, PageWrite::ignoredStale);

    CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>(late));
  }
}

TEST(page_returns_nullopt_until_written) {
  FakeJournalRepository repo;
  PageService service(repo);

  CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>());

  Page stored = pageOn("2026-07-27", "here", hlc(10));
  service.write(stored);
  CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>(stored));
}

TEST(range_returns_the_inclusive_window_oldest_first) {
  FakeJournalRepository repo;
  PageService service(repo);

  Page d25 = pageOn("2026-07-25", "mon", hlc(10));
  Page d26 = pageOn("2026-07-26", "tue", hlc(20));
  Page d27 = pageOn("2026-07-27", "wed", hlc(30));
  Page d28 = pageOn("2026-07-28", "thu", hlc(40));
  for (const Page& p : {d25, d26, d27, d28}) service.write(p);

  std::vector<Page> window = service.range(uid(), ld("2026-07-26"), ld("2026-07-27"));
  CHECK_EQ(window, (std::vector<Page>{d26, d27}));   // both endpoints included, oldest first
}

TEST(since_returns_only_stamps_past_the_cursor_ascending_and_capped) {
  FakeJournalRepository repo;
  PageService service(repo);

  Page a = pageOn("2026-07-25", "a", hlc(10));
  Page b = pageOn("2026-07-26", "b", hlc(20));
  Page c = pageOn("2026-07-27", "c", hlc(30));
  Page d = pageOn("2026-07-28", "d", hlc(40));
  for (const Page& p : {a, b, c, d}) service.write(p);

  // strictly greater than the cursor: hlc(20) drops b itself and keeps c, d.
  CHECK_EQ(service.since(uid(), hlc(20), 10), (std::vector<Page>{c, d}));

  // the limit caps the ascending feed at its head.
  CHECK_EQ(service.since(uid(), hlc(0), 2), (std::vector<Page>{a, b}));
}

TEST(all_returns_every_page_oldest_first) {
  FakeJournalRepository repo;
  PageService service(repo);

  Page a = pageOn("2026-07-27", "c", hlc(30));
  Page b = pageOn("2026-07-25", "a", hlc(10));
  Page c = pageOn("2026-07-26", "b", hlc(20));
  for (const Page& p : {a, b, c}) service.write(p);   // inserted out of day order

  CHECK_EQ(service.all(uid()), (std::vector<Page>{b, c, a}));   // 25th, 26th, 27th
}
