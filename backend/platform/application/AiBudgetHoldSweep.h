#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Heartbeat.h"

#include <memory>
#include <utility>

namespace wm {

// Releases every lapsed hold each minute, so one whose principal never calls or reads again stops holding the shared
// free pools. Its own class because it owns the heartbeat thread, which AiBudgetService must never carry.
class AiBudgetHoldSweep {
public:
  explicit AiBudgetHoldSweep(std::shared_ptr<AiBudgetService> budgets) : budgets_(std::move(budgets)) {}

  void start() { heartbeat_.start(kFirstTickSeconds, kPeriodSeconds, [this] { budgets_->releaseLapsed(); }); }
  void stop() { heartbeat_.stop(); }

private:
  static constexpr double kFirstTickSeconds = 30;
  static constexpr double kPeriodSeconds = 60;

  std::shared_ptr<AiBudgetService> budgets_;
  // Last, so it destructs first — the rule Heartbeat asks of its callers.
  Heartbeat heartbeat_{"ai-budget-holds"};
};

}
