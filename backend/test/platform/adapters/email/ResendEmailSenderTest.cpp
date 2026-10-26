#include "platform/adapters/email/ResendClient.h"

#include "test/testing.h"

#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <future>
#include <memory>
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
  // A tree title reaches a HEADER here, where a CR or an LF ends the header rather than being a stray character.
  CHECK(emailSafeTitle("Sail\r\nBcc: someone@evil.test") == "SailBcc: someone@evil.test");
  CHECK(emailSafeTitle(std::string("Sail\0plan", 9)) == "Sailplan");
  CHECK(emailSafeTitle("Tabs\tand\vwhitespace") == "Tabsandwhitespace");
  CHECK(emailSafeTitle("delete\x7f") == "delete");
  // Bytes above 0x7F are left alone, because that is where UTF-8 lives.
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

TEST(resend_email_body_carries_the_sign_in_code_for_the_magic_code_template) {
  // The app door's wire bytes: template id 'magic-code', the digits under sign_in_code, no subject (it lives on the stored template) and no headers.
  Json::Value vars(Json::objectValue);
  vars["sign_in_code"] = "483201";
  const Json::Value body = resendEmailBody("Windmill <hi@windmill.works>", "you@example.com",
                                           "magic-code", vars, Json::Value(Json::objectValue));
  CHECK_EQ(body["from"].asString(), std::string("Windmill <hi@windmill.works>"));
  CHECK_EQ(body["to"].asString(), std::string("you@example.com"));
  CHECK_EQ(body["template"]["id"].asString(), std::string("magic-code"));
  CHECK_EQ(body["template"]["variables"]["sign_in_code"].asString(), std::string("483201"));
  CHECK_FALSE(body.isMember("subject"));
  CHECK_FALSE(body.isMember("headers"));
}

TEST(resend_email_body_omits_headers_when_there_are_none) {
  // A sign-in link is transactional and carries no unsubscribe, so the field must be absent rather than an empty object.
  const Json::Value body = resendEmailBody("from", "to", "magic-link",
                                           Json::Value(Json::objectValue), Json::Value(Json::objectValue));
  CHECK_FALSE(body.isMember("headers"));
}

TEST(reminder_unsubscribe_headers_are_the_rfc_8058_one_click_pair) {
  // The URL in angle brackets (RFC 2369) and the one-click marker (RFC 8058) that tells the client to POST, not GET.
  const Json::Value headers =
      reminderUnsubscribeHeaders("https://windmill.works/v1/reminders/unsubscribe?t=s1");
  CHECK_EQ(headers["List-Unsubscribe"].asString(),
           std::string("<https://windmill.works/v1/reminders/unsubscribe?t=s1>"));
  CHECK_EQ(headers["List-Unsubscribe-Post"].asString(), std::string("List-Unsubscribe=One-Click"));
}

TEST(resend_email_body_embeds_the_reminder_headers_it_is_given) {
  const Json::Value body =
      resendEmailBody("from", "to", "reminder", Json::Value(Json::objectValue),
                      reminderUnsubscribeHeaders("https://windmill.works/v1/reminders/unsubscribe?t=s1"));
  CHECK_EQ(body["headers"]["List-Unsubscribe"].asString(),
           std::string("<https://windmill.works/v1/reminders/unsubscribe?t=s1>"));
  CHECK_EQ(body["headers"]["List-Unsubscribe-Post"].asString(),
           std::string("List-Unsubscribe=One-Click"));
}

TEST(resend_transport_uses_the_injected_origin_and_only_accepts_successful_delivery) {
  for (const int status : {200, 302, 422}) {
    const auto closeSocket = [](int* descriptor) { ::close(*descriptor); delete descriptor; };
    const std::unique_ptr<int, decltype(closeSocket)> listener{new int(::socket(AF_INET, SOCK_STREAM, 0)), closeSocket};
    REQUIRE(*listener >= 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    REQUIRE_EQ(::bind(*listener, reinterpret_cast<const sockaddr*>(&address), sizeof address), 0);
    socklen_t size = sizeof address;
    REQUIRE_EQ(::getsockname(*listener, reinterpret_cast<sockaddr*>(&address), &size), 0);
    REQUIRE_EQ(::listen(*listener, 1), 0);

    auto received = std::async(std::launch::async, [fd = *listener, status, closeSocket] {
      pollfd ready{fd, POLLIN, 0};
      if (::poll(&ready, 1, 5000) != 1) return std::string{};
      const std::unique_ptr<int, decltype(closeSocket)> peer{new int(::accept(fd, nullptr, nullptr)), closeSocket};
      if (*peer < 0) return std::string{};
      const timeval timeout{5, 0};
      ::setsockopt(*peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
      std::string request;
      while (request.size() < 65536) {
        char buffer[4096];
        const auto count = ::recv(*peer, buffer, sizeof buffer, 0);
        if (count <= 0) return std::string{};
        request.append(buffer, static_cast<std::size_t>(count));
        const auto boundary = request.find("\r\n\r\n");
        if (boundary == std::string::npos) continue;
        std::string headers = request.substr(0, boundary);
        std::transform(headers.begin(), headers.end(), headers.begin(), [](unsigned char value) { return std::tolower(value); });
        const auto length = headers.find("content-length:");
        if (length == std::string::npos) return std::string{};
        if (request.size() >= boundary + 4 + std::stoull(headers.substr(length + 15))) break;
      }
      const std::string body = "PRIVATE_PROVIDER_RESPONSE";
      const std::string response = "HTTP/1.1 " + std::to_string(status) + " Fixture\r\nContent-Length: " +
          std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
      ::send(*peer, response.data(), response.size(), 0);
      return request;
    });
    const auto answer = std::make_shared<std::promise<bool>>();
    auto result = answer->get_future();
    ResendClient client{"local-fixture-only", "Windmill <sender@example.test>",
                        "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port))};
    Json::Value variables(Json::objectValue);
    variables["sign_in_code"] = "246810";
    client.send(Email{"recipient@example.test"}, "magic-code", variables, Json::Value(Json::objectValue),
                [answer](bool delivered) { answer->set_value(delivered); });
    REQUIRE(result.wait_for(std::chrono::seconds(12)) == std::future_status::ready);
    CHECK_EQ(result.get(), status == 200);
    const std::string request = received.get();
    const auto boundary = request.find("\r\n\r\n");
    REQUIRE(boundary != std::string::npos);
    CHECK_EQ(request.substr(0, request.find("\r\n")), std::string("POST /emails HTTP/1.1"));
    CHECK(request.find("authorization: Bearer local-fixture-only\r\n") != std::string::npos);
    CHECK_EQ(request.substr(boundary + 4), std::string(
        R"({"from":"Windmill <sender@example.test>","template":{"id":"magic-code","variables":{"sign_in_code":"246810"}},"to":"recipient@example.test"})"));
  }
}

TEST(resend_transport_without_a_key_refuses_without_opening_the_injected_origin) {
  ResendClient client{"", "Windmill <sender@example.test>", "http://127.0.0.1:1"};
  int callbacks = 0;
  client.send(Email{"recipient@example.test"}, "magic-code", Json::Value(Json::objectValue),
              Json::Value(Json::objectValue), [&](bool delivered) { CHECK_FALSE(delivered); ++callbacks; });
  CHECK_EQ(callbacks, 1);
}
