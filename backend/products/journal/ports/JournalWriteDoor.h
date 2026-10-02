#pragma once

#include "products/journal/ports/JournalRepository.h"

#include <json/json.h>

namespace wm {

struct WriteOutcome {
  Page page;
  PageWrite result;
};

namespace journal {

class JournalWriteDoor {
public:
  virtual ~JournalWriteDoor() = default;
  virtual WriteOutcome savePage(const Page&) = 0;
  virtual Json::Value claimPage(const UserId&, const Json::Value&) = 0;
  virtual Json::Value journalState(const UserId&, const Json::Value&) = 0;
};

}
}
