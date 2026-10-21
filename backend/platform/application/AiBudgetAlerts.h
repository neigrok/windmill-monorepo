#pragma once

#include "platform/application/AiBudgetService.h"
#include "platform/application/Heartbeat.h"
#include "platform/ports/Clock.h"
#include "platform/ports/EmailSender.h"

#include <stdexcept>

namespace wm {

class AiBudgetAlerts {
public:
  AiBudgetAlerts(std::shared_ptr<AiBudgetService> budgets, std::shared_ptr<EmailSender> email,
                 std::shared_ptr<Clock> clock, Email recipient)
      : budgets_(std::move(budgets)), email_(std::move(email)), clock_(std::move(clock)),
        recipient_(std::move(recipient)) {}

  void start() { heartbeat_.start(15, 60, [this] { run(); }); }
  void stop() { heartbeat_.stop(); }

  void run() {
    for (const auto& alert : budgets_->claimAlerts()) {
      auto observation = std::make_shared<WriteObservation>("ai.budget.alert_send", "platform", "background");
      auto budgets = budgets_;
      auto clock = clock_;
      const auto finish = [budgets, clock, alert, observation](bool sent) {
        WriteContext context{*observation};
        try {
          const auto code = sent ? budgets->completeAlert(alert.id, alert.claimToken)
              : budgets->retryAlert(alert.id, alert.claimToken, clock->nowMs() + 300'000);
          if (code != AiBudgetCode::Ok && code != AiBudgetCode::Replay)
            throw std::runtime_error("AI alert claim changed");
          if (!sent) {
            observation->fail(std::runtime_error("AI alert delivery failed"));
            return;
          }
          observation->finish("delivered");
        } catch (const std::exception& error) { observation->fail(error); }
        catch (...) { observation->failUnknown(); }
      };
      try { email_->sendAiAllowanceAlert(recipient_, alert, finish); }
      catch (...) { finish(false); }
    }
  }

private:
  std::shared_ptr<AiBudgetService> budgets_;
  std::shared_ptr<EmailSender> email_;
  std::shared_ptr<Clock> clock_;
  Email recipient_;
  Heartbeat heartbeat_{"ai-budget-alerts"};
};

}
