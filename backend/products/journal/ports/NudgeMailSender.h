#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// The daily journal nudge, already rendered. The body copy lives in the provider's 'journal-nudge'
// template and never travels here; the mailer only binds the three links. unsubscribeUrl is the
// RFC 8058 one-click target that becomes the header.
struct JournalNudgeMail {
  std::string settingsUrl;
  std::string pauseUrl;
  std::string unsubscribeUrl;
};

// The journal-owned nudge mail port ('journal-nudge'). done fires exactly once with the delivery
// verdict, and the sweep only stamps a day as sent on a true.
struct NudgeMailSender {
  virtual ~NudgeMailSender() = default;
  virtual void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                std::function<void(bool)> done) = 0;
};

}
