#pragma once

#include "platform/domain/Auth.h"
#include "products/roadmap/domain/Reminders.h"

#include <array>
#include <functional>
#include <string>

namespace wm {

// The weekly reminder, already rendered: every field is a finished string or number, so the mailer
// only binds them to template variables. `readyPhrase` counts the featured tree's ready steps,
// `moreOnTree` the ones this mail had no room to name, and `moreReady` the OTHER trees also
// waiting; each is empty when it has nothing to say.
//
// The step slots are FIXED rather than a list the provider iterates; an empty label is an unused
// slot. `colorHex` is one of the six hues rendered server-side, because it lands inside a style
// attribute where markup stripping does not protect it.
struct ReminderMail {
  struct Step {
    std::string label;
    std::string colorHex;
  };

  std::string treeName;
  std::string treeUrl;
  std::string settingsUrl;
  std::string pauseUrl;
  // The RFC 8058 one-click target — a mail client POSTs it when the reader presses "unsubscribe".
  // A bare endpoint, so its secret rides the query, not a fragment. It becomes the List-Unsubscribe
  // header, not a variable.
  std::string unsubscribeUrl;
  int done = 0;
  int total = 0;
  std::string readyPhrase;
  std::string moreOnTree;
  std::string moreReady;
  std::array<Step, kMaxSteps> steps;
};

// The roadmap-owned reminder mail port ('reminder'). Same asynchronous contract as the platform's
// EmailSender: done fires exactly once with the delivery verdict, and the sweep only stamps a row
// as sent on a true.
struct ReminderMailSender {
  virtual ~ReminderMailSender() = default;
  virtual void sendReminder(const Email& to, const ReminderMail& mail,
                            std::function<void(bool)> done) = 0;
};

}
