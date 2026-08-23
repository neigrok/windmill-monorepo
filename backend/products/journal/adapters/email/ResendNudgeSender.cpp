#include "products/journal/adapters/email/ResendNudgeSender.h"

#include <utility>

namespace wm {

ResendNudgeSender::ResendNudgeSender(ResendClient& client) : client_(client) {}

void ResendNudgeSender::sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                                         std::function<void(bool)> done) {
  // The one fixed line lives in the provider's template; this binds only the three links, so no
  // user-authored text can ride into a nudge. The one-click pair goes as message headers.
  Json::Value variables(Json::objectValue);
  variables["settings_url"] = mail.settingsUrl;
  variables["pause_url"] = mail.pauseUrl;
  variables["unsubscribe_url"] = mail.unsubscribeUrl;
  client_.send(to, "journal-nudge", variables, reminderUnsubscribeHeaders(mail.unsubscribeUrl),
               std::move(done));
}

}
