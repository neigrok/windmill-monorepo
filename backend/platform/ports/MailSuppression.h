#pragma once

#include "platform/domain/Auth.h"

#include <memory>
#include <string>

namespace wm {

// What one product does when the provider reports a mailbox gone; the verdict itself is made once
// in platform/domain/Mail.h. Suppression is a sending state only: nothing in the sign-in path may
// read it, and lifting the flag restores the owner's choice rather than a default.
struct MailSuppression {
  virtual ~MailSuppression() = default;

  // Keyed by address, and idempotent: the value written is a constant, so a redelivered webhook
  // performs the identical write. False means no live account owns that address — log it, never
  // answer with it, or the door becomes an account-existence oracle.
  virtual bool stopMailing(const Email& address) = 0;
};

// The composition root assembles the list; every product that sends mail must appear, or it keeps
// writing to an address the provider has already called dead.
struct MailStream {
  std::string name;                             // "roadmap reminder", "journal nudge"
  std::shared_ptr<MailSuppression> suppression;
};

}
