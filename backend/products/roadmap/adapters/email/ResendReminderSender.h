#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "products/roadmap/ports/ReminderMailSender.h"

#include <functional>

namespace wm {

class ResendReminderSender : public ReminderMailSender {
public:
  explicit ResendReminderSender(ResendClient& client);

  void sendReminder(const Email& to, const ReminderMail& mail,
                    std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}
