#pragma once

#include "platform/domain/Auth.h"

#include <functional>
#include <string>

namespace wm {

// The daily journal nudge, already rendered. The body line is fixed and lives in the provider's
// 'journal-nudge' template ("The house is quiet. Three minutes?") — it never travels here, so a
// bad word can't ride in; the mailer only binds the three links. Platform-neutral strings, so this
// port stays free of any journal type. settingsUrl reaches the nudge panel, pauseUrl is the "pause
// for a week" page, unsubscribeUrl is the RFC 8058 one-click target that becomes the header.
struct JournalNudgeMail {
  std::string settingsUrl;
  std::string pauseUrl;
  std::string unsubscribeUrl;
};

// The journal-owned nudge mail port ('journal-nudge'). It lives beside the product that owns the
// nudge, so the platform mail seam never names one. Same asynchronous contract as the platform's
// EmailSender: done fires exactly once with the delivery verdict, and the sweep only stamps a day
// as sent on a true.
struct NudgeMailSender {
  virtual ~NudgeMailSender() = default;
  virtual void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                std::function<void(bool)> done) = 0;
};

}
