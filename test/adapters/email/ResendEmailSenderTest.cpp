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
