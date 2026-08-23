#pragma once

#include "platform/domain/Auth.h"
#include "products/roadmap/domain/Reminders.h"

#include <array>
#include <functional>
#include <string>

namespace wm {

// The weekly reminder, already rendered: every field is a finished string or number, so the mailer
// only binds them to template variables. `readyPhrase`, `moreOnTree` and `moreReady` are each empty
// when they have nothing to say.
//
// The step slots are FIXED rather than a list the provider iterates; an empty label is an unused
// slot. `colorHex` is rendered server-side because it lands inside a style attribute where markup
// stripping does not protect it.
struct ReminderMail {
  struct Step {
    std::string label;
    std::string colorHex;
  };

  std::string treeName;
  std::string treeUrl;
  std::string settingsUrl;
  std::string pauseUrl;
  // The RFC 8058 one-click target: a bare endpoint a mail client POSTs, so its secret rides the
  // query, not a fragment. It becomes the List-Unsubscribe header, not a variable.
  std::string unsubscribeUrl;
  int done = 0;
  int total = 0;
  std::string readyPhrase;
  std::string moreOnTree;
  std::string moreReady;
  std::array<Step, kMaxSteps> steps;
};

  // done fires exactly once with the delivery verdict, and the sweep only stamps a row as sent on
  // a true.
struct ReminderMailSender {
  virtual ~ReminderMailSender() = default;
  virtual void sendReminder(const Email& to, const ReminderMail& mail,
                            std::function<void(bool)> done) = 0;
};

}
