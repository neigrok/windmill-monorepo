#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "products/roadmap/ports/ReminderMailSender.h"

#include <functional>

namespace wm {

// The weekly reminder over Resend: it binds the mail's rendered fields to the 'reminder' template
// and hands the send to the shared ResendClient. It owns no transport of its own — the loop, the
// api key and the from address all live in the client, so this adapter is only the reminder's
// variable-binding, kept next to the product whose mail it is.
class ResendReminderSender : public ReminderMailSender {
public:
  explicit ResendReminderSender(ResendClient& client);

  void sendReminder(const Email& to, const ReminderMail& mail,
                    std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}
