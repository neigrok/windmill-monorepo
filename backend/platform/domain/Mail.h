#pragma once

#include "platform/domain/Auth.h"

#include <string>

namespace wm {

// One thing the mail provider told us about one address, and the single question this file answers
// about it: does it end every stream Windmill writes to that mailbox.
//
// There is one Resend account, so one delivery stream carries feedback about every mail this brand
// sends — a hard bounce on the sign-in link is the same dead mailbox as a hard bounce on the weekly
// reminder. Nothing here names a product, and that is the point: reachability is a fact about a
// MAILBOX. WHICH streams stop is each product's answer (platform/ports/MailSuppression.h); WHETHER
// they should is this one, made once for all of them.
//
// Resend speaks SES's bounce taxonomy, and the whole rule turns on it. `Permanent` is a mailbox that
// does not exist — writing to it again buys nothing and spends deliverability shared with the magic
// link, which is the only door into an account. `Transient` is a mailbox that could not take THIS
// message today: full, throttled, oversized. Stopping on a transient bounce is the defect a naive
// reading ships, because it silences someone for a week their inbox happened to be full.
// `Undetermined`, an absent severity, and an event type we do not recognise are all the same answer
// as a transient bounce: not evidence. A state we are unsure of must never be resolved by guessing
// against the person.
//
// A complaint needs no severity at all — someone pressed "spam", and continuing to mail them is how
// a sender loses its whole domain.
enum class MailVerdict { keepMailing, stopMailing };

// The provider's event as the rule sees it: the event's name, the bounce severity if it carried
// one, and who it was about. The recipient is here because the rule's ANSWER is about a person, not
// because the rule reads it — resolving the address is the caller's next step, not this one's.
struct MailFeedback {
  MailFeedback() = default;
  MailFeedback(std::string eventType, std::string bounceType, Email recipient);

  std::string eventType;   // Resend's `type`: "email.bounced", "email.complained", …
  std::string bounceType;  // Resend's `data.bounce.type`: "Permanent" | "Transient" | "Undetermined"
  Email recipient;
};

MailVerdict verdictOn(const MailFeedback& feedback);

}
