#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "products/roadmap/ports/ReminderMailSender.h"

#include <functional>

namespace wm {

// The weekly reminder over Resend: binds the mail's rendered fields to the 'reminder' template
// and hands the send to the shared ResendClient. No transport of its own — the loop, the api key
// and the from address all live in the client.
class ResendReminderSender : public ReminderMailSender {
public:
  explicit ResendReminderSender(ResendClient& client);

  void sendReminder(const Email& to, const ReminderMail& mail,
                    std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}
