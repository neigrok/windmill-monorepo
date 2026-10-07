#pragma once

#include "platform/ports/ChangeFeed.h"
#include "products/journal/ports/PageWatcher.h"

#include <exception>

namespace wm::journal::engine {

class JournalFeed final : public sync::ChangeFeed {
public:
  JournalFeed(PageWatcher& watcher, sync::ChangeFeed& next) : watcher_(watcher), next_(next) {}

  void publish(const sync::CommittedChange& change) override {
    std::exception_ptr failure;
    try { next_.publish(change); } catch (...) { failure = std::current_exception(); }
    for (const auto& scope : change.changed) {
      if (scope.key.kind() != sync::ScopeKind::product || scope.key.product() != "journal") continue;
      for (const auto& row : scope.rows) {
        if (row["t"] != "page") continue;
        try {
          watcher_.pageSaved(scope.owner, LocalDate(row["id"].asString()), row["x"]["body"]["text"].asString().size());
        } catch (...) {
          if (!failure) failure = std::current_exception();
        }
      }
    }
    if (failure) std::rethrow_exception(failure);
  }

private:
  PageWatcher& watcher_;
  sync::ChangeFeed& next_;
};

}
