#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/ports/Clock.h"
#include "platform/ports/ChangeFeed.h"
#include "platform/ports/FailureReporter.h"
#include "products/journal/application/PageService.h"
#include "products/journal/ports/JournalWriteDoor.h"

#include <memory>

namespace wm::journal {

class JournalDoor final : public JournalWriteDoor {
public:
  JournalDoor(std::shared_ptr<PgPool>, Clock&, FailureReporter&, PageWatcher&,
              std::shared_ptr<sync::SyncCatalog>, sync::ChangeFeed* = nullptr);
  ~JournalDoor() override;
  WriteOutcome savePage(const Page&) override;
  Json::Value claimPage(const UserId&, const Json::Value&) override;
  Json::Value journalState(const UserId&, const Json::Value&) override;

private:
  Json::Value execute(const UserId&, const Json::Value&, WriteOutcome* = nullptr);
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}
