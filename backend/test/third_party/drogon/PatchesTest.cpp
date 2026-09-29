#include "test/DrogonLoopback.h"
#include "test/testing.h"

#include <drogon/Cookie.h>
#include <drogon/HttpResponse.h>

#include <algorithm>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

// What third_party/drogon/patches promise, on requests Drogon's own parser reads off a loopback connection: a request
// keeps every header line it was received with, and a request object Drogon hands on to a later request on the
// connection keeps none of the earlier one's (0001); a response writes its raw Set-Cookie header first and then a
// cookie per name, domain and path (0002); a request whose field lines or framing RFC 9112 calls invalid is refused
// and never handed over (0003), while one Transfer-Encoding line naming a coding the parser does not decode stays
// upstream's 501.

using wm::test::DrogonLoopback;

namespace {

using Lines = std::vector<std::pair<std::string, std::string>>;

// Every Set-Cookie line of an answer, in wire order, without the field name.
std::vector<std::string> setCookieLines(const std::string& answer) {
  std::vector<std::string> lines;
  std::istringstream text(answer.substr(0, answer.find("\r\n\r\n")));
  for (std::string line; std::getline(text, line);) {
    std::string name = line.substr(0, line.find(':'));
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (name == "set-cookie") lines.push_back(line.substr(line.find(':') + 2, line.size() - line.find(':') - 3));
  }
  return lines;
}

drogon::Cookie sessionCookie(const std::string& value, const std::string& domain) {
  drogon::Cookie cookie("wm_session", value);
  cookie.setPath("/");
  if (!domain.empty()) cookie.setDomain(domain);
  cookie.setMaxAge(0);
  return cookie;
}

}

TEST(a_request_keeps_every_header_line_it_was_received_with_each_name_as_sent_and_the_bytes_after_its_colon) {
  DrogonLoopback::Connection connection;
  const DrogonLoopback::Exchange exchange = connection.exchange(
      "GET /lines HTTP/1.1\r\nHost: t\r\nCookie: a=1\r\ncookie:b=2 \t\r\nCOOKIE:\t wm_session\r\nAuthorization: Bearer x\r\n"
      "authorization: Basic y\r\nCoo\xE2\x84\xAAie: wm_session=z\r\n\r\n");
  REQUIRE(exchange.request);
  CHECK(exchange.request->headerOccurrences() == (Lines{{"Host", " t"},
                                                        {"Cookie", " a=1"},
                                                        {"cookie", "b=2 \t"},
                                                        {"COOKIE", "\t wm_session"},
                                                        {"Authorization", " Bearer x"},
                                                        {"authorization", " Basic y"},
                                                        {"Coo\xE2\x84\xAAie", " wm_session=z"}}));
  CHECK_EQ(exchange.request->getHeader("authorization"), std::string("Bearer x"));
}

TEST(a_request_object_handed_on_to_a_later_request_on_the_connection_keeps_none_of_the_earlier_lines) {
  DrogonLoopback::Connection connection;
  for (int round = 0; round < 8; ++round) {
    const DrogonLoopback::Exchange credentialed =
        connection.exchange("GET /a HTTP/1.1\r\nHost: t\r\nCookie: wm_session=s-ann\r\nAuthorization: Bearer s-bob\r\n\r\n");
    REQUIRE(credentialed.request);
    CHECK(credentialed.request->headerOccurrences() == (Lines{{"Host", " t"}, {"Cookie", " wm_session=s-ann"}, {"Authorization", " Bearer s-bob"}}));
    const DrogonLoopback::Exchange chunked =
        connection.exchange("POST /b HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n0\r\n\r\n");
    REQUIRE(chunked.request);
    CHECK(chunked.request->headerOccurrences() == (Lines{{"Host", " t"}, {"Transfer-Encoding", " chunked"}}));
    CHECK_EQ(std::string(chunked.request->body()), std::string("abc"));
    const DrogonLoopback::Exchange continued =
        connection.exchange("POST /c HTTP/1.1\r\nHost: t\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n{}");
    REQUIRE(continued.request);
    CHECK(continued.answer.starts_with("HTTP/1.1 100 "));
    CHECK(continued.request->headerOccurrences() == (Lines{{"Host", " t"}, {"Expect", " 100-continue"}, {"Content-Length", " 2"}}));
    const DrogonLoopback::Exchange bare = connection.exchange("GET /d HTTP/1.1\r\nHost: t\r\n\r\n");
    REQUIRE(bare.request);
    CHECK(bare.request->headerOccurrences() == (Lines{{"Host", " t"}}));
  }
}

TEST(a_request_with_a_field_line_rfc_9112_calls_invalid_is_refused_and_never_handed_over) {
  for (const std::string lines : {"garbage\r\nCookie: wm_session=s-ann\r\n",          // no colon: not the end of the head
                                  ": empty-name\r\n",
                                  "Cookie : wm_session=s-ann\r\n",                    // whitespace before the colon
                                  "Cookie: theme=dark\r\n wm_session=s-ann\r\n",      // a line folded onto the one before
                                  "X-A: 1\r\n\tAuthorization: Bearer s-ann\r\n",
                                  "X-A: 1\nAuthorization: Bearer s-ann\r\n",          // a bare LF
                                  "X-A: 1\rAuthorization: Bearer s-ann\r\n"}) {       // a bare CR
    DrogonLoopback::Connection connection;
    const DrogonLoopback::Exchange exchange = connection.exchange("GET /v HTTP/1.1\r\nHost: t\r\n" + lines + "\r\n");
    CHECK(exchange.answer.starts_with("HTTP/1.1 400 "));
    CHECK(exchange.request == nullptr);
  }
}

TEST(a_request_with_content_length_twice_or_beside_transfer_encoding_or_with_two_transfer_encoding_lines_is_refused) {
  for (const std::string framing : {"Content-Length: 5\r\nTransfer-Encoding: chunked\r\n",
                                    "transfer-encoding: chunked\r\nCONTENT-LENGTH: 5\r\n",
                                    "Content-Length: 5\r\nContent-Length: 5\r\n",
                                    "Content-Length: 5\r\ncontent-length: 50\r\n",
                                    "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n",
                                    "Transfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n"}) {
    DrogonLoopback::Connection connection;
    const DrogonLoopback::Exchange exchange = connection.exchange("POST /f HTTP/1.1\r\nHost: t\r\n" + framing + "\r\n0\r\n\r\n");
    CHECK(exchange.answer.starts_with("HTTP/1.1 400 "));
    CHECK(exchange.request == nullptr);
  }
  DrogonLoopback::Connection connection;
  const DrogonLoopback::Exchange coded = connection.exchange("POST /f HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n");
  CHECK(coded.answer.starts_with("HTTP/1.1 501 "));
  CHECK(coded.request == nullptr);
}

TEST(a_response_writes_its_raw_set_cookie_header_first_then_a_cookie_per_name_domain_and_path) {
  DrogonLoopback::Connection connection;
  const DrogonLoopback::Exchange exchange = connection.exchange("GET /cookies HTTP/1.1\r\nHost: t\r\n\r\n", [](const drogon::HttpRequestPtr&) {
    auto response = drogon::HttpResponse::newHttpResponse();
    response->addHeader("Set-Cookie", "wm_session=live; Domain=example.com; Path=/");
    response->addCookie(sessionCookie("stale", ""));
    response->addCookie(sessionCookie("", "old.example.com"));
    response->addCookie(sessionCookie("", "example.com"));
    response->addCookie(sessionCookie("", ""));
    return response;
  });
  std::vector<std::string> lines = setCookieLines(exchange.answer);
  REQUIRE_EQ(lines.size(), std::size_t{4});
  CHECK_EQ(lines[0], std::string("wm_session=live; Domain=example.com; Path=/"));
  std::sort(lines.begin() + 1, lines.end());
  CHECK_EQ(lines, (std::vector<std::string>{"wm_session=live; Domain=example.com; Path=/",
                                            "wm_session=; Max-Age=0; Domain=example.com; Path=/; HttpOnly",
                                            "wm_session=; Max-Age=0; Domain=old.example.com; Path=/; HttpOnly",
                                            "wm_session=; Max-Age=0; Path=/; HttpOnly"}));
}

TEST(a_response_finds_and_removes_its_cookies_by_name_in_every_scope) {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->addCookie(sessionCookie("", "example.com"));
  response->addCookie(sessionCookie("", ""));
  response->addCookie("theme", "dark");
  CHECK_EQ(response->cookies().size(), std::size_t{3});
  CHECK_EQ(response->getCookie("wm_session").key(), std::string("wm_session"));
  response->removeCookie("wm_session");
  CHECK_EQ(response->cookies().size(), std::size_t{1});
  CHECK_EQ(response->getCookie("theme").value(), std::string("dark"));
}
