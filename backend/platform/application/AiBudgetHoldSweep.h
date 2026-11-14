#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Heartbeat.h"

#include <atomic>
#include <memory>
#include <utility>

namespace wm {

// Releases every lapsed hold each minute, so one whose principal never calls or reads again stops holding the shared
// free pools. Its own class because it owns the heartbeat thread, which AiBudgetService must never carry.
class AiBudgetHoldSweep {
public:
  explicit AiBudgetHoldSweep(std::shared_ptr<AiBudgetService> budgets) : budgets_(std::move(budgets)) {}

  void start() {
    heartbeat_.start(kFirstTickSeconds, kPeriodSeconds, [this] {
      budgets_->releaseLapsed([this] { return stopping_.load(); });
    });
  }
  // A pass under way finishes the batch it is in and starts no other.
  void stop() {
    stopping_ = true;
    heartbeat_.stop();
  }

private:
  static constexpr double kFirstTickSeconds = 30;
  static constexpr double kPeriodSeconds = 60;

  std::shared_ptr<AiBudgetService> budgets_;
  std::atomic<bool> stopping_{false};
  // Last, so it destructs first — the rule Heartbeat asks of its callers.
  Heartbeat heartbeat_{"ai-budget-holds"};
};

}
