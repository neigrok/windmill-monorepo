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
