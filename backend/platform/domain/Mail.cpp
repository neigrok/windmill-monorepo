#include "platform/domain/Mail.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace wm {

MailFeedback::MailFeedback(std::string eventType, std::string bounceType, Email recipient)
    : eventType(std::move(eventType)), bounceType(std::move(bounceType)),
      recipient(std::move(recipient)) {}

MailVerdict verdictOn(const MailFeedback& feedback) {
  // A complaint carries no severity.
  if (feedback.eventType == "email.complained") return MailVerdict::stopMailing;
  // Any other event type, known or not, says nothing about reachability.
  if (feedback.eventType != "email.bounced") return MailVerdict::keepMailing;

  // Only a permanent bounce stops mailing; matched case-insensitively, since an exact compare
  // fails silently as a soft bounce.
  std::string severity = feedback.bounceType;
  std::transform(severity.begin(), severity.end(), severity.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  if (severity != "permanent") return MailVerdict::keepMailing;
  return MailVerdict::stopMailing;
}

}
