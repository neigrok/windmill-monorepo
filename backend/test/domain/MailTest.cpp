#include "platform/domain/Mail.h"
#include "test/testing.h"

#include <string>

using namespace wm;

// The whole matrix, because it is the whole feature: which provider events end the mail Windmill
// writes to an address. The rule is platform's and names no product — every product that mails
// stops on exactly this answer, which is why it is decided once and here.
//
// The recipient is carried but never read: every case below uses the same address and the answers
// differ anyway, which is the point.

namespace {
MailVerdict verdictFor(const char* eventType, const char* bounceType = "") {
  return verdictOn(MailFeedback{eventType, bounceType, Email{"sam@example.com"}});
}
}

TEST(a_permanent_bounce_ends_every_stream_to_that_mailbox) {
  // The mailbox does not exist. Mailing it again buys nothing and spends deliverability shared
  // with the magic link, which is the only door into the account.
  CHECK(verdictFor("email.bounced", "Permanent") == MailVerdict::stopMailing);
  // Matched case-insensitively, because an exact compare fails SILENTLY: every hard bounce would
  // read as soft and we would mail dead addresses forever — the exact defect this rule exists for.
  CHECK(verdictFor("email.bounced", "permanent") == MailVerdict::stopMailing);
  CHECK(verdictFor("email.bounced", "PERMANENT") == MailVerdict::stopMailing);
}

TEST(a_soft_bounce_ends_nothing) {
  // A full, throttled or oversized mailbox is a bad Tuesday, not a dead address. Stopping here
  // silences someone for a week their inbox happened to be full, and nothing ever tells them why.
  CHECK(verdictFor("email.bounced", "Transient") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "transient") == MailVerdict::keepMailing);
  // Undetermined is Resend saying it does not know either. Neither do we, so nothing changes.
  CHECK(verdictFor("email.bounced", "Undetermined") == MailVerdict::keepMailing);
  // And an absent severity is not a severity: a bounce whose shape we cannot read is not evidence.
  CHECK(verdictFor("email.bounced", "") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.bounced", "Perma") == MailVerdict::keepMailing);
}

TEST(a_spam_complaint_ends_the_mail_with_no_severity_to_read) {
  // Someone pressed "spam". There is nothing to weigh and nothing to wait for — continuing to mail
  // them is how a sender loses its whole domain.
  CHECK(verdictFor("email.complained") == MailVerdict::stopMailing);
  CHECK(verdictFor("email.complained", "Transient") == MailVerdict::stopMailing);
}

TEST(every_other_delivery_event_changes_nothing) {
  // Including one that does not exist yet: an unrecognised type must be a no-op, never a stop and
  // never an error, or the next event Resend invents silences the fleet.
  CHECK(verdictFor("email.sent") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.delivered") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.delivery_delayed") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.opened") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.clicked") == MailVerdict::keepMailing);
  CHECK(verdictFor("email.quarantined") == MailVerdict::keepMailing);
  CHECK(verdictFor("") == MailVerdict::keepMailing);
  // A permanent severity riding on an event that is not a bounce is not a bounce.
  CHECK(verdictFor("email.delivered", "Permanent") == MailVerdict::keepMailing);
}

TEST(mail_feedback_keeps_the_recipient_the_rule_never_reads) {
  // The verdict is about a person, so the event carries who it was about — resolving that address
  // is the caller's next step, and the rule's answer must not depend on it.
  const MailFeedback feedback{"email.bounced", "Permanent", Email{"sam@example.com"}};

  CHECK_EQ(feedback.eventType, std::string("email.bounced"));
  CHECK_EQ(feedback.bounceType, std::string("Permanent"));
  CHECK_EQ(feedback.recipient.value, std::string("sam@example.com"));
  CHECK(verdictOn(feedback) == MailVerdict::stopMailing);
  CHECK(verdictOn(MailFeedback{"email.bounced", "Permanent", Email{}}) == MailVerdict::stopMailing);
}
