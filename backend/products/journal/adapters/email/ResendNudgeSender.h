#pragma once

#include "platform/adapters/email/ResendClient.h"
#include "products/journal/ports/NudgeMailSender.h"

#include <functional>

namespace wm {

// The daily journal nudge over Resend: it binds the mail's three links to the 'journal-nudge'
// template and hands the send to the shared ResendClient. It owns no transport of its own — the
// loop, the api key and the from address all live in the client, so this adapter is only the
// nudge's variable-binding, kept next to the product whose mail it is.
class ResendNudgeSender : public NudgeMailSender {
public:
  explicit ResendNudgeSender(ResendClient& client);

  void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                        std::function<void(bool)> done) override;

private:
  ResendClient& client_;
};

}
