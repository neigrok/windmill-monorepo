#include "platform/adapters/http/CredentialTap.h"

#include "test/testing.h"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

// CredentialTap, fed bytes as a connection receives them: what it hands Drogon, whole, for requests framed every way
// HTTP/1.1 frames them and split at every byte; each head it refuses; the upgrade's verdict; and the field it writes,
// read back.

using namespace wm;
using namespace std::string_literals;

namespace {

// Everything `tap` hands on for `chunks`, fed in order, and whether a feed refused the connection.
struct Handed {
  std::string forward;
  bool refused = false;
};

Handed feedAll(CredentialTap& tap, const std::vector<std::string_view>& chunks) {
  Handed handed;
  for (const std::string_view chunk : chunks) {
    const CredentialTap::Fed fed = tap.feed(chunk);
    handed.forward += fed.forward;
    handed.refused = handed.refused || fed.refuses;
  }
  return handed;
}

Handed feedWhole(std::string_view bytes) {
  CredentialTap tap;
  return feedAll(tap, {bytes});
}

std::string fieldText(const std::optional<std::vector<sync::SentCredential>>& sent) {
  if (!sent) return "unreadable";
  std::string text;
  for (const sync::SentCredential& credential : *sent) {
    text += credential.kind == sync::SentCredential::Kind::authorization ? "authorization " : "cookie ";
    text += credential.token.value_or("-") + "\n";
  }
  return text;
}

}

TEST(the_tap_hands_on_every_request_with_every_credential_its_fields_send) {
  const Handed handed = feedWhole(
      "GET /v1/sync/hello HTTP/1.1\r\n"
      "Host: api\r\n"
      "Cookie: theme=dark; wm_session=s-ann\r\n"
      "cookie:   wm_session=s-bob  \r\n"
      "Authorization: Bearer s-ann\r\n"
      "\r\n"
      "POST /v1/sync/push HTTP/1.1\r\n"
      "Content-Length: 5\r\n"
      "\r\n"
      "hello"
      "GET /v1/sync/hello HTTP/1.1\r\n"
      "Authorization: Basic czphbm4=\r\n"
      "Cookie: wm_session\r\n"
      "\r\n");
  CHECK_FALSE(handed.refused);
  CHECK_EQ(handed.forward, std::string("GET /v1/sync/hello HTTP/1.1\r\n"
                                       "Host: api\r\n"
                                       "Cookie: theme=dark; wm_session=s-ann\r\n"
                                       "cookie: wm_session=s-bob\r\n"
                                       "Authorization: Bearer s-ann\r\n"
                                       "wm-sent-credentials: cookie=cy1hbm4,cookie=cy1ib2I,authorization=cy1hbm4\r\n"
                                       "\r\n"
                                       "POST /v1/sync/push HTTP/1.1\r\n"
                                       "Content-Length: 5\r\n"
                                       "wm-sent-credentials: none\r\n"
                                       "\r\n"
                                       "hello"
                                       "GET /v1/sync/hello HTTP/1.1\r\n"
                                       "Authorization: Basic czphbm4=\r\n"
                                       "Cookie: wm_session\r\n"
                                       "wm-sent-credentials: authorization,cookie\r\n"
                                       "\r\n"));
}

TEST(the_tap_drops_a_sent_credentials_field_the_request_sends_itself) {
  CHECK_EQ(feedWhole("GET / HTTP/1.1\r\nWM-Sent-Credentials: cookie=cy1ib2I\r\nwm-sent-credentials: none\r\n\r\n").forward,
           std::string("GET / HTTP/1.1\r\nwm-sent-credentials: none\r\n\r\n"));
}

TEST(the_tap_chunks_a_chunked_body_again_without_its_extensions) {
  const Handed handed = feedWhole(
      "POST /p HTTP/1.1\r\n"
      "Transfer-Encoding: chunked\r\n"
      "\r\n"
      "5;name=value\r\nhello\r\n"
      "00A \t; x\r\n0123456789\r\n"
      "0\r\n\r\n"
      "GET /next HTTP/1.1\r\n\r\n");
  CHECK_FALSE(handed.refused);
  CHECK_EQ(handed.forward, std::string("POST /p HTTP/1.1\r\n"
                                       "Transfer-Encoding: chunked\r\n"
                                       "wm-sent-credentials: none\r\n"
                                       "\r\n"
                                       "5\r\nhello\r\n"
                                       "a\r\n0123456789\r\n"
                                       "0\r\n\r\n"
                                       "GET /next HTTP/1.1\r\n"
                                       "wm-sent-credentials: none\r\n"
                                       "\r\n"));
}

TEST(the_tap_hands_on_the_same_bytes_however_the_connection_splits_them) {
  const std::string stream =
      "POST /a HTTP/1.1\r\nCookie: wm_session=s-ann\r\nContent-Length: 12\r\n\r\n\r\n\r\nbody\r\n\r\n"
      "POST /b HTTP/1.1\r\nTransfer-Encoding: chunked\r\nAuthorization: Bearer s-bob\r\n\r\n3;e\r\n\r\n\r\r\n1\r\nx\r\n0\r\n\r\n"
      "GET /c HTTP/1.1\r\n\r\n";
  const Handed whole = feedWhole(stream);
  CHECK_FALSE(whole.refused);
  CHECK_EQ(whole.forward, std::string("POST /a HTTP/1.1\r\nCookie: wm_session=s-ann\r\nContent-Length: 12\r\n"
                                      "wm-sent-credentials: cookie=cy1hbm4\r\n\r\n\r\n\r\nbody\r\n\r\n"
                                      "POST /b HTTP/1.1\r\nTransfer-Encoding: chunked\r\nAuthorization: Bearer s-bob\r\n"
                                      "wm-sent-credentials: authorization=cy1ib2I\r\n\r\n3\r\n\r\n\r\r\n1\r\nx\r\n0\r\n\r\n"
                                      "GET /c HTTP/1.1\r\nwm-sent-credentials: none\r\n\r\n"));
  for (std::size_t split = 1; split < stream.size(); ++split) {
    CredentialTap tap;
    const Handed halves = feedAll(tap, {std::string_view(stream).substr(0, split), std::string_view(stream).substr(split)});
    CHECK_EQ(halves.forward, whole.forward);
    CHECK_FALSE(halves.refused);
  }
  CredentialTap tap;
  std::vector<std::string_view> bytes;
  for (std::size_t at = 0; at < stream.size(); ++at) bytes.push_back(std::string_view(stream).substr(at, 1));
  CHECK_EQ(feedAll(tap, bytes).forward, whole.forward);
}

TEST(the_tap_refuses_a_request_drogon_could_read_apart_from_it_and_hands_on_what_came_before) {
  const std::string before = "GET /ok HTTP/1.1\r\n\r\n";
  const std::string handedBefore = "GET /ok HTTP/1.1\r\nwm-sent-credentials: none\r\n\r\n";
  const std::vector<std::string> refused{
      "\r\n\r\n",
      "GET /\tx HTTP/1.1\r\n\r\n",
      "GET / HTTP/1.1\r\nCookie: a=1\r\n wm_session=s-ann\r\n\r\n",
      "GET / HTTP/1.1\r\nCookie: a=1\nCookie: wm_session=s-ann\r\n\r\n",
      "GET / HTTP/1.1\r\nCookie: wm_session=s-ann\rCookie: b\r\n\r\n",
      "GET / HTTP/1.1\r\nno colon here\r\n\r\n",
      "GET / HTTP/1.1\r\n: empty name\r\n\r\n",
      "GET / HTTP/1.1\r\nAuthorization : Bearer s-ann\r\n\r\n",
      "GET / HTTP/1.1\r\nAuth(orization): Bearer s-ann\r\n\r\n",
      "GET / HTTP/1.1\r\nCookie: wm_session=s-ann\0x\r\n\r\n"s,
      "GET / HTTP/1.1\r\nCookie: wm_session=s-\x7F\r\n\r\n",
      "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
      "POST / HTTP/1.1\r\nContent-Length: +1\r\n\r\nx",
      "POST / HTTP/1.1\r\nContent-Length: 1, 1\r\n\r\nx",
      "POST / HTTP/1.1\r\nContent-Length: 99999999999999999999\r\n\r\n",
      "POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: Chunked\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1 x\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1000000000000000\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxy\r\n",
      "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nAuthorization: Bearer s-ann\r\n\r\n",
  };
  for (const std::string& request : refused) {
    CredentialTap tap;
    const CredentialTap::Fed fed = tap.feed(before + request);
    CHECK(fed.refuses);
    CHECK(fed.forward.starts_with(handedBefore));
    const CredentialTap::Fed after = tap.feed("GET / HTTP/1.1\r\n\r\n");
    CHECK_EQ(after.forward, std::string());
    CHECK_FALSE(after.refuses);
  }
}

TEST(the_tap_refuses_a_head_that_grows_past_its_bound_without_ending) {
  CredentialTap tap;
  CHECK_FALSE(tap.feed("GET / HTTP/1.1\r\nCookie: " + std::string(CredentialTap::kMaxHeadBytes - 30, 'a')).refuses);
  CHECK(tap.feed(std::string(64, 'a')).refuses);
}

TEST(after_an_upgrade_the_next_byte_decides_between_a_websocket_frame_and_another_request) {
  const std::string upgrade = "GET /v1/sync/live?schema=2 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
  const std::string handedUpgrade =
      "GET /v1/sync/live?schema=2 HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nwm-sent-credentials: none\r\n\r\n";
  const std::string frame = "\x81\x85\x01\x02\x03\x04hello";
  const std::string twoCookies = "GET / HTTP/1.1\r\nCookie: wm_session=a; wm_session=b\r\n\r\n";

  CredentialTap upgraded;
  CHECK_EQ(feedAll(upgraded, {upgrade, frame, twoCookies}).forward, handedUpgrade + frame + twoCookies);

  CredentialTap refused;
  CHECK_EQ(feedAll(refused, {upgrade, twoCookies}).forward,
           handedUpgrade + "GET / HTTP/1.1\r\nCookie: wm_session=a; wm_session=b\r\nwm-sent-credentials: cookie=YQ,cookie=Yg\r\n\r\n");

  CredentialTap later;
  const Handed laterUpgrade = feedAll(later, {"GET /first HTTP/1.1\r\n\r\n", upgrade, frame});
  CHECK_EQ(laterUpgrade.forward, "GET /first HTTP/1.1\r\nwm-sent-credentials: none\r\n\r\n" + handedUpgrade);
  CHECK_FALSE(laterUpgrade.refused);
  CHECK(later.feed("\r\n\r\n").refuses);
}

TEST(the_sent_credentials_field_reads_back_only_what_the_tap_writes) {
  const std::vector<sync::SentCredential> sent{{sync::SentCredential::Kind::cookie, "s-ann"},
                                               {sync::SentCredential::Kind::authorization, std::nullopt},
                                               {sync::SentCredential::Kind::authorization, std::string("\"quoted\" \x80", 10)}};
  CHECK_EQ(fieldText(parseSentCredentialsField(sentCredentialsFieldOf(sent))),
           std::string("cookie s-ann\nauthorization -\nauthorization \"quoted\" \x80\n"));
  CHECK_EQ(fieldText(parseSentCredentialsField("none")), std::string());
  for (const std::string_view unreadable : {"", "none,cookie", "cookie,", ",cookie", "cookie=", "cookie=a+b", "bearer=YQ", "Cookie=YQ"}) {
    CHECK_EQ(fieldText(parseSentCredentialsField(unreadable)), std::string("unreadable"));
  }
}
