#include "products/journal/adapters/email/ResendNudgeSender.h"

#include <utility>

namespace wm {

ResendNudgeSender::ResendNudgeSender(ResendClient& client) : client_(client) {}

void ResendNudgeSender::sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                         std::function<void(bool)> done) {
  // The one fixed line lives in the provider's template; this adapter binds only the three links,
  // so no user-authored text can ride into a nudge at all. The one-click pair goes as message
  // headers, exactly as the reminder's does.
  Json::Value variables(Json::objectValue);
  variables["settings_url"] = mail.settingsUrl;
  variables["pause_url"] = mail.pauseUrl;
  variables["unsubscribe_url"] = mail.unsubscribeUrl;
  client_.send(to, "journal-nudge", variables, reminderUnsubscribeHeaders(mail.unsubscribeUrl),
               std::move(done));
}

}
