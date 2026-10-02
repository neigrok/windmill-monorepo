#pragma once

#include "products/journal/ports/JournalRepository.h"
#include "products/journal/ports/JournalWriteDoor.h"

#include <cstddef>
#include <optional>
#include <vector>

namespace wm {

// Told after every save that changed the stored page. Implementations must return immediately:
// this is called on a drogon handler thread.
struct PageWatcher {
  virtual ~PageWatcher() = default;
  virtual void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) = 0;
};

// The HTTP adapter talks to this, never to the repository.
class PageService {
public:
  explicit PageService(JournalRepository& repo, PageWatcher* watcher = nullptr,
                       journal::JournalWriteDoor* door = nullptr);

  WriteOutcome write(const Page& incoming);
  std::optional<Page> page(const UserId& user, const LocalDate& day);
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to);
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit);
  std::vector<Page> all(const UserId& user);

private:
  JournalRepository& repo_;
  PageWatcher* watcher_;
  journal::JournalWriteDoor* door_;
};

}
