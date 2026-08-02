#include "platform/domain/Mail.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace wm {

MailFeedback::MailFeedback(std::string eventType, std::string bounceType, Email recipient)
    : eventType(std::move(eventType)), bounceType(std::move(bounceType)),
      recipient(std::move(recipient)) {}

MailVerdict verdictOn(const MailFeedback& feedback) {
  // Someone pressed "spam". There is no severity to weigh and nothing to wait for.
  if (feedback.eventType == "email.complained") return MailVerdict::stopMailing;
  // Delivered, opened, clicked, delayed, or an event type that does not exist yet: none of them
  // says anything about whether this address is reachable next week.
  if (feedback.eventType != "email.bounced") return MailVerdict::keepMailing;

  // Only a PERMANENT bounce ends it. The severity is matched case-insensitively because the way an
  // exact compare fails is silently — every hard bounce would read as soft, and we would go on
  // mailing dead addresses forever, which is the very thing this rule exists to stop.
  std::string severity = feedback.bounceType;
  std::transform(severity.begin(), severity.end(), severity.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  if (severity != "permanent") return MailVerdict::keepMailing;
  return MailVerdict::stopMailing;
}

}
