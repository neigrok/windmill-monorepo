#include "adapters/email/ResendEmailSender.h"

#include "test/testing.h"

#include <string>

using namespace wm;

TEST(email_safe_title_strips_every_angle_bracket) {
  CHECK(emailSafeTitle("<img src=x onerror=alert(1)>") == "img src=x onerror=alert(1)");
  CHECK(emailSafeTitle("</td><a href=\"https://evil\">click</a>") ==
        "/tda href=\"https://evil\"click/a");
  CHECK(emailSafeTitle("<<>>") == "");
}

TEST(email_safe_title_leaves_honest_titles_untouched) {
  CHECK(emailSafeTitle("Learn to sail") == "Learn to sail");
  CHECK(emailSafeTitle("Fun & Games — the \"Big\" Plan") == "Fun & Games — the \"Big\" Plan");
  CHECK(emailSafeTitle("") == "");
}

TEST(email_safe_title_preserves_multibyte_utf8) {
  CHECK(emailSafeTitle("Выучить C++ 🌳") == "Выучить C++ 🌳");
  CHECK(emailSafeTitle("日本語<script>を学ぶ") == "日本語scriptを学ぶ");
}

TEST(email_safe_title_strips_control_characters_because_a_title_now_reaches_a_subject) {
  // A tree title carries no length or charset validation anywhere in the system, and the weekly
  // reminder's subject is "{{{ready_phrase}}} ready · {{{tree_name}}}" — the first time a person's
  // own words reach a HEADER rather than a body, where a CR or an LF is not a stray character but
  // the end of the header. Whether a given provider would honour that is not ours to find out.
  CHECK(emailSafeTitle("Sail\r\nBcc: someone@evil.test") == "SailBcc: someone@evil.test");
  CHECK(emailSafeTitle(std::string("Sail\0plan", 9)) == "Sailplan");
  CHECK(emailSafeTitle("Tabs\tand\vwhitespace") == "Tabsandwhitespace");
  CHECK(emailSafeTitle("delete\x7f") == "delete");
  // And the bytes above 0x7F are left alone, because that is where UTF-8 lives.
  CHECK(emailSafeTitle("\r\n日本語\r\n") == "日本語");
}

TEST(resend_email_body_carries_the_template_and_recipient) {
  Json::Value vars(Json::objectValue);
  vars["magic_link"] = "https://windmill.works/link";
  const Json::Value body = resendEmailBody("Windmill <hi@windmill.works>", "you@example.com",
                                           "magic-link", vars, Json::Value(Json::objectValue));
  CHECK_EQ(body["from"].asString(), std::string("Windmill <hi@windmill.works>"));
  CHECK_EQ(body["to"].asString(), std::string("you@example.com"));
  CHECK_EQ(body["template"]["id"].asString(), std::string("magic-link"));
  CHECK_EQ(body["template"]["variables"]["magic_link"].asString(),
           std::string("https://windmill.works/link"));
}

TEST(resend_email_body_omits_headers_when_there_are_none) {
  // A sign-in link is transactional and carries no unsubscribe, so the field must be absent rather
  // than an empty object a provider might read as an empty header set.
  const Json::Value body = resendEmailBody("from", "to", "magic-link",
                                           Json::Value(Json::objectValue), Json::Value(Json::objectValue));
  CHECK_FALSE(body.isMember("headers"));
}

TEST(reminder_unsubscribe_headers_are_the_rfc_8058_one_click_pair) {
  // The exact header shape the reminder send builds from its unsubscribe URL: the URL in angle
  // brackets (RFC 2369) and the one-click marker (RFC 8058) that tells the client to POST, not GET.
  const Json::Value headers =
      reminderUnsubscribeHeaders("https://windmill.works/v1/reminders/unsubscribe?t=s1");
  CHECK_EQ(headers["List-Unsubscribe"].asString(),
           std::string("<https://windmill.works/v1/reminders/unsubscribe?t=s1>"));
  CHECK_EQ(headers["List-Unsubscribe-Post"].asString(), std::string("List-Unsubscribe=One-Click"));
}

TEST(resend_email_body_embeds_the_reminder_headers_it_is_given) {
  // And the header object the reminder builds lands under `headers` in the wire body Resend receives.
  const Json::Value body =
      resendEmailBody("from", "to", "reminder", Json::Value(Json::objectValue),
                      reminderUnsubscribeHeaders("https://windmill.works/v1/reminders/unsubscribe?t=s1"));
  CHECK_EQ(body["headers"]["List-Unsubscribe"].asString(),
           std::string("<https://windmill.works/v1/reminders/unsubscribe?t=s1>"));
  CHECK_EQ(body["headers"]["List-Unsubscribe-Post"].asString(),
           std::string("List-Unsubscribe=One-Click"));
}
