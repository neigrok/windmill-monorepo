#include "products/roadmap/adapters/email/ResendReminderSender.h"

#include <cstddef>
#include <string>
#include <utility>

namespace wm {

ResendReminderSender::ResendReminderSender(ResendClient& client) : client_(client) {}

void ResendReminderSender::sendReminder(const Email& to, const ReminderMail& mail,
                                        std::function<void(bool)> done) {
  Json::Value variables(Json::objectValue);
  // The two positions that carry someone's own words shed markup first; the hue beside each step
  // never does, because it is one of six server-chosen literals landing inside a style attribute,
  // where angle-bracket stripping would not have protected it anyway.
  variables["tree_name"] = emailSafeTitle(mail.treeName);
  variables["tree_url"] = mail.treeUrl;
  variables["settings_url"] = mail.settingsUrl;
  variables["pause_url"] = mail.pauseUrl;
  variables["done"] = mail.done;
  variables["total"] = mail.total;
  // Every counted sentence arrives finished, worded in the pure core. This adapter binds; it does
  // not write copy — plurals and units included.
  variables["ready_phrase"] = mail.readyPhrase;
  variables["more_on_tree"] = mail.moreOnTree;
  variables["more_ready"] = mail.moreReady;
  // Three fixed slots rather than a list the provider iterates: the template documents this
  // fallback, three is the cap regardless, and an empty label simply renders an empty row.
  for (std::size_t slot = 0; slot < mail.steps.size(); ++slot) {
    const std::string prefix = "step_" + std::to_string(slot + 1) + "_";
    variables[prefix + "label"] = emailSafeTitle(mail.steps[slot].label);
    variables[prefix + "color"] = mail.steps[slot].colorHex;
  }
  // The one-click unsubscribe rides as message headers, not template variables — only the reminder
  // carries them, because a sign-in link is transactional and has nothing to leave.
  client_.send(to, "reminder", variables, reminderUnsubscribeHeaders(mail.unsubscribeUrl),
               std::move(done));
}

}
