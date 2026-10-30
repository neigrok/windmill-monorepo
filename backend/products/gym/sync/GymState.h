#pragma once

#include "platform/ports/SyncType.h"

#include <array>

namespace wm::gym::engine {

// The receipt books a gym scope keeps beside its records (engine A.2), named as the corpus names them.
inline constexpr std::array<const char*, 5> kReceiptBooks{"starts", "imports", "corrections", "proposalApplies", "workoutProposalApplies"};

class GymState {
public:
  virtual ~GymState() = default;
  virtual Json::Value load(sync::SyncTxn&, const sync::ScopeKey&) = 0;
  virtual void receipt(sync::SyncTxn&, const sync::ScopeKey&, const std::string& kind,
                       const std::string& id, const Json::Value& receipt) = 0;
};

}
