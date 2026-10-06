#pragma once

#include "platform/ports/SyncType.h"

namespace wm::journal::engine {

class JournalState {
public:
  virtual ~JournalState() = default;
  virtual Json::Value load(sync::SyncTxn&, const sync::ScopeKey&) = 0;
  virtual void receipt(sync::SyncTxn&, const sync::ScopeKey&, const std::string& claimId,
                       const Json::Value&) = 0;
  virtual void saveClock(sync::SyncTxn&, const sync::ScopeKey&, const Json::Value& pair) = 0;
};

}
