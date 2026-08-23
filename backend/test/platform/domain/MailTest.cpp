#include "platform/domain/Mail.h"
#include "test/testing.h"

#include <string>

using namespace wm;

namespace {
MailVerdict verdictFor(const char* eventType, const char* bounceType = "") {
  return verdictOn(MailFeedback{eventType, bounceType, Email{"sam@example.com"}});
}
}

TEST(a_permanent_bounce_ends_every_stream_to_that_mailbox) {
  CHECK(verdictFor("email.bounced", "Permanent") == MailVerdict::stopMailing);
  // Matched case-insensitively: an exact compare fails SILENTLY, and every hard bounce would read as soft.
  CHECK(verdictFor("email.bounced", "permanent") == MailVerdict::stopMailing);
  CHECK(verdictFor("email.bounced", "PERMANENT") == MailVerdict::stopMailing);
}

TEST(a_soft_bounce_ends_nothing) {
  CHECK(verdictFor("email.bounced", "Transient") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "transient") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "Undetermined") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "Perma") == MailVerdict::keepMailing);
}

TEST(a_spam_complaint_ends_the_mail_with_no_severity_to_read) {
  CHECK(verdictFor("email.complained") == MailVerdict::stopMailing);
  CHECK(verdictFor("email.complained", "Transient") == MailVerdict::stopMailing);
}

TEST(every_other_delivery_event_changes_nothing) {
  // An unrecognised type must be a no-op, never a stop and never an error.
  CHECK(verdictFor("email.sent") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.delivered") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.delivery_delayed") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.opened") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.clicked") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.quarantined") == MailVerdict::keepMailing);
  CHECK(verdictFor("") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.delivered", "Permanent") == MailVerdict::keepMailing);
}

TEST(mail_feedback_keeps_the_recipient_the_rule_never_reads) {
  const MailFeedback feedback{"email.bounced", "Permanent", Email{"sam@example.com"}};

  CHECK_EQ(feedback.eventType, std::string("email.bounced"));
  CHECK_EQ(feedback.bounceType, std::string("Permanent"));
  CHECK_EQ(feedback.recipient.value, std::string("sam@example.com"));
  CHECK(verdictOn(feedback) == MailVerdict::stopMailing);
  CHECK(verdictOn(MailFeedback{"email.bounced", "Permanent", Email{}}) == MailVerdict::stopMailing);
}
