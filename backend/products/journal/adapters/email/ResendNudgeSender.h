#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "products/journal/ports/NudgeMailSender.h"

#include <functional>

namespace wm {

// Binds the mail's three links to the 'journal-nudge' template and hands the send to ResendClient.
class ResendNudgeSender : public NudgeMailSender {
public:
  explicit ResendNudgeSender(ResendClient& client);

  void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                        std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}
