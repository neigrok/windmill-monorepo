#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// Body copy lives in the provider's 'journal-nudge' template; the mailer only binds these links.
// unsubscribeUrl is the RFC 8058 one-click target that becomes the header.
struct JournalNudgeMail {
  std::string settingsUrl;
  std::string pauseUrl;
  std::string unsubscribeUrl;
};

// done fires exactly once with the delivery verdict; the sweep stamps a day sent only on true.
struct NudgeMailSender {
  virtual ~NudgeMailSender() = default;
  virtual void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                std::function<void(bool)> done) = 0;
};

}
