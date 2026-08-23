#include "products/journal/application/PageService.h"

namespace wm {

PageService::PageService(JournalRepository& repo, PageWatcher* watcher)
    : repo_(repo), watcher_(watcher) {}

// A write that lost the last-writer-wins guard announces nothing; the announcement names the
// winning body, not the incoming one.
WriteOutcome PageService::write(const Page& incoming) {
  PageWrite result = repo_.save(incoming);
  std::optional<Page> winner = repo_.load(incoming.user, incoming.day);
  const Page settled = winner ? *winner : incoming;
  if (watcher_ && result != PageWrite::ignoredStale)
    watcher_->pageSaved(settled.user, settled.day, settled.body.size());
  return {settled, result};
}

std::optional<Page> PageService::page(const UserId& user, const LocalDate& day) {
  return repo_.load(user, day);
}

std::vector<Page> PageService::range(const UserId& user, const LocalDate& from, const LocalDate& to) {
  return repo_.range(user, from, to);
}

std::vector<Page> PageService::since(const UserId& user, const Hlc& cursor, int limit) {
  return repo_.since(user, cursor, limit);
}

std::vector<Page> PageService::all(const UserId& user) {
  return repo_.all(user);
}

}
