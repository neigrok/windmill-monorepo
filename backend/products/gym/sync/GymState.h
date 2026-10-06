#pragma once

#include "platform/ports/SyncType.h"

namespace wm::gym::engine {

class GymState {
public:
  virtual ~GymState() = default;
  virtual Json::Value load(sync::SyncTxn&, const sync::ScopeKey&) = 0;
  virtual void receipt(sync::SyncTxn&, const sync::ScopeKey&, const std::string& kind,
                       const std::string& id, const Json::Value& receipt) = 0;
};

}
