#pragma once

#include "platform/domain/Auth.h"

#include <string>

namespace wm {

// Whether one provider event ends every stream Windmill writes to a mailbox; which streams stop is
// each product's answer (platform/ports/MailSuppression.h). Resend speaks SES's bounce taxonomy:
// only `Permanent` stops mailing. `Transient`, `Undetermined`, an absent severity and an
// unrecognised event type are all not evidence. A complaint stops mailing with no severity at all.
enum class MailVerdict { keepMailing, stopMailing };

struct MailFeedback {
  MailFeedback() = default;
  MailFeedback(std::string eventType, std::string bounceType, Email recipient);

  std::string eventType;   // Resend's `type`: "email.bounced", "email.complained", …
  std::string bounceType;  // Resend's `data.bounce.type`: "Permanent" | "Transient" | "Undetermined"
  Email recipient;
};

MailVerdict verdictOn(const MailFeedback& feedback);

}
