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

// A page as the store holds it once the engine admitted it.
void stored(FakeJournalRepository& repo, const Page& page) {
  repo.byKey.emplace(FakeJournalRepository::key(page.user, page.day), page);
}
}

TEST(page_returns_nullopt_until_written) {
  FakeJournalRepository repo;
  PageService service(repo);

  CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>());

  Page written = pageOn("2026-07-27", "here", hlc(10));
  stored(repo, written);
  CHECK_EQ(service.page(uid(), ld("2026-07-27")), std::optional<Page>(written));
}

TEST(range_returns_the_inclusive_window_oldest_first) {
  FakeJournalRepository repo;
  PageService service(repo);

  Page d25 = pageOn("2026-07-25", "mon", hlc(10));
  Page d26 = pageOn("2026-07-26", "tue", hlc(20));
  Page d27 = pageOn("2026-07-27", "wed", hlc(30));
  Page d28 = pageOn("2026-07-28", "thu", hlc(40));
  for (const Page& p : {d25, d26, d27, d28}) stored(repo, p);

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
  for (const Page& p : {a, b, c, d}) stored(repo, p);

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
  for (const Page& p : {a, b, c}) stored(repo, p);   // stored out of day order

  CHECK_EQ(service.all(uid()), (std::vector<Page>{b, c, a}));   // 25th, 26th, 27th
}
