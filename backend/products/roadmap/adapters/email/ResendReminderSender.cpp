#include "products/roadmap/adapters/email/ResendReminderSender.h"

#include <cstddef>
#include <string>
#include <utility>

namespace wm {

ResendReminderSender::ResendReminderSender(ResendClient& client) : client_(client) {}

void ResendReminderSender::sendReminder(const Email& to, const ReminderMail& mail,
                                        std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  variables["tree_name"] = emailSafeTitle(mail.treeName);
  variables["tree_url"] = mail.treeUrl;
  variables["settings_url"] = mail.settingsUrl;
  variables["pause_url"] = mail.pauseUrl;
  variables["done"] = mail.done;
  variables["total"] = mail.total;
  variables["ready_phrase"] = mail.readyPhrase;
  variables["more_on_tree"] = mail.moreOnTree;
  variables["more_ready"] = mail.moreReady;
  for (std::size_t slot = 0; slot < mail.steps.size(); ++slot) {
    const std::string prefix = "step_" + std::to_string(slot + 1) + "_";
    variables[prefix + "label"] = emailSafeTitle(mail.steps[slot].label);
    variables[prefix + "color"] = mail.steps[slot].colorHex;
  }
  client_.send(to, "reminder", variables, reminderUnsubscribeHeaders(mail.unsubscribeUrl),
               std::move(done));
}

}
