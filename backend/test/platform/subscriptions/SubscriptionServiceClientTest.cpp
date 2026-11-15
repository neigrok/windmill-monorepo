#include "platform/subscriptions/SubscriptionServiceClient.h"

#include "platform/adapters/json/JsonText.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {
// The service's internal port, stood up on 127.0.0.1 at a port the OS picks: each connection is answered with the next
// canned reply and closed, and each request's bytes, its body included, are kept. A connection that never comes is given
// up after 5 s.
class StubService {
public:
  explicit StubService(std::vector<std::string> replies) : listener_(::socket(AF_INET, SOCK_STREAM, 0)) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof address) != 0 || ::listen(listener_, 4) != 0)
      throw std::runtime_error("the stub service could not listen");
    socklen_t size = sizeof address;
    ::getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size);
    port_ = ntohs(address.sin_port);
    server_ = std::thread([this, replies = std::move(replies)] {
      for (const std::string& reply : replies) {
        pollfd waiting{listener_, POLLIN, 0};
        if (::poll(&waiting, 1, 5'000) != 1) return;
        const int peer = ::accept(listener_, nullptr, nullptr);
        std::string request;
        char buffer[4096];
        while (request.find("\r\n\r\n") == std::string::npos || request.size() < headEnd(request) + bodyLength(request)) {
          const ssize_t read = ::recv(peer, buffer, sizeof buffer, 0);
          if (read <= 0) break;
          request.append(buffer, static_cast<std::size_t>(read));
        }
        requests_.push_back(request);
        ::send(peer, reply.data(), reply.size(), 0);
        ::close(peer);
      }
    });
  }

  ~StubService() {
    if (server_.joinable()) server_.join();
    ::close(listener_);
  }

  std::string url() const { return "http://127.0.0.1:" + std::to_string(port_); }

  std::vector<std::string> requests() {
    if (server_.joinable()) server_.join();
    return requests_;
  }

  static std::size_t headEnd(const std::string& request) { return request.find("\r\n\r\n") + 4; }

  static std::size_t bodyLength(const std::string& request) {
    std::string head = request.substr(0, headEnd(request));
    std::transform(head.begin(), head.end(), head.begin(), [](unsigned char c) { return std::tolower(c); });
    const std::size_t field = head.find("\r\ncontent-length:");
    return field == std::string::npos ? 0 : std::stoul(head.substr(field + 17));
  }

  static std::string reply(int status, const std::string& body) {
    return "HTTP/1.1 " + std::to_string(status) + " Stub\r\nContent-Type: application/json\r\nContent-Length: " +
           std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
  }

private:
  int listener_;
  int port_ = 0;
  std::thread server_;
  std::vector<std::string> requests_;
};

std::string answerOf(SubscriptionServiceClient& client) {
  try {
    client.page(0, 500);
  } catch (const FeedUnavailable& unavailable) {
    return unavailable.answer;
  }
  return "read";
}

std::string lowered(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return std::tolower(c); });
  return text;
}
}

TEST(subscription_service_client_reads_a_feed_page_after_the_cursor_with_its_bearer_secret) {
  const std::string page = dump(contractExample("feed.json", "claimed_then_sandbox")["body"]);
  StubService service{{StubService::reply(200, page), StubService::reply(200, page)}};
  SubscriptionServiceClient client{ServiceAddress{service.url(), "internal-secret"}};
  SubscriptionServiceClient mounted{ServiceAddress{service.url() + "/subscriptions/", "internal-secret"}};

  const FeedPage read = client.page(6, 500);
  CHECK_EQ(read.epoch, std::string("c09a3ab3-2732-4415-ba88-825ff868cf13"));
  CHECK_EQ(read.latestSeq, Seq{27});
  REQUIRE_EQ(read.entries.size(), std::size_t{6});
  CHECK_EQ(read.entries.back().seq, Seq{13});
  CHECK_EQ(read.entries.back().entitlement->body, entitlementExample("sandbox_active"));
  mounted.page(6, 500);

  const std::vector<std::string> requests = service.requests();
  REQUIRE_EQ(requests.size(), std::size_t{2});
  const std::string first = requests[0].substr(0, requests[0].find("\r\n"));
  CHECK(first == "GET /internal/v1/feed?after=6&limit=500 HTTP/1.1" ||
        first == "GET /internal/v1/feed?limit=500&after=6 HTTP/1.1");
  CHECK(lowered(requests[0]).find("\r\nauthorization: bearer internal-secret\r\n") != std::string::npos);
  CHECK(requests[1].starts_with("GET /subscriptions/internal/v1/feed?"));
}

TEST(subscription_service_client_reads_a_refusal_or_a_body_the_contract_does_not_describe_as_an_unavailable_feed) {
  Json::Value broken = contractExample("feed.json", "from_zero")["body"];
  broken.removeMember("latestSeq");
  StubService service{{StubService::reply(401, R"({"code":"unauthorized"})"), StubService::reply(503, ""),
                       StubService::reply(200, "PRIVATE_NOT_JSON"), StubService::reply(200, dump(broken))}};
  SubscriptionServiceClient client{ServiceAddress{service.url(), "wrong-secret"}};

  std::string answers;
  for (int read = 0; read < 4; ++read) answers += answerOf(client) + " ";
  CHECK_EQ(answers, std::string("401 503 malformed malformed "));
}

TEST(subscription_service_client_reads_a_service_that_is_not_listening_as_an_unavailable_feed) {
  std::string url;
  {
    StubService closed{{}};
    url = closed.url();
  }
  SubscriptionServiceClient client{ServiceAddress{url, "internal-secret"}};
  CHECK_EQ(answerOf(client), std::string("unreachable"));
}

TEST(subscription_service_client_looks_its_host_up_at_every_read_and_names_it_as_the_host) {
  const std::string page = dump(contractExample("feed.json", "caught_up")["body"]);
  StubService service{{StubService::reply(200, page), StubService::reply(200, page)}};
  const std::string port = service.url().substr(service.url().rfind(':') + 1);
  SubscriptionServiceClient client{ServiceAddress{"http://localhost:" + port, "internal-secret"}};
  SubscriptionServiceClient nowhere{ServiceAddress{"http://subscriptions-internal.invalid:" + port, "internal-secret"}};

  CHECK_EQ(answerOf(client), std::string("read"));
  CHECK_EQ(answerOf(client), std::string("read"));
  CHECK_EQ(answerOf(nowhere), std::string("unreachable"));

  const std::vector<std::string> requests = service.requests();
  REQUIRE_EQ(requests.size(), std::size_t{2});
  for (const std::string& request : requests)
    CHECK(lowered(request).find("\r\nhost: localhost:" + port + "\r\n") != std::string::npos);
}

TEST(subscription_service_address_is_both_variables_or_neither) {
  CHECK_FALSE(ServiceAddress::from(nullptr, nullptr).has_value());
  CHECK_FALSE(ServiceAddress::from("", "").has_value());

  const std::optional<ServiceAddress> both = ServiceAddress::from("http://subscriptions:8083", "internal-secret");
  REQUIRE(both.has_value());
  CHECK_EQ(both->url, std::string("http://subscriptions:8083"));
  CHECK_EQ(both->token, std::string("internal-secret"));

  const auto refusal = [](const char* url, const char* token) -> std::string {
    try {
      ServiceAddress::from(url, token);
    } catch (const std::invalid_argument& missing) {
      return missing.what();
    }
    return "accepted";
  };
  CHECK_EQ(refusal("http://subscriptions:8083", nullptr),
           std::string("SUBSCRIPTIONS_INTERNAL_TOKEN is required with SUBSCRIPTIONS_INTERNAL_URL"));
  CHECK_EQ(refusal("http://subscriptions:8083", ""),
           std::string("SUBSCRIPTIONS_INTERNAL_TOKEN is required with SUBSCRIPTIONS_INTERNAL_URL"));
  CHECK_EQ(refusal(nullptr, "internal-secret"),
           std::string("SUBSCRIPTIONS_INTERNAL_URL is required with SUBSCRIPTIONS_INTERNAL_TOKEN"));
}

// Each answer internal-app-store-claim.json pins, as the service serves it: its claim is posted with the account the
// caller's session names and the bearer secret, as one compact body, and the answer reads as its seq or its refusal's
// code. The longest transaction a claim forwards leaves the body within what the service takes.
TEST(subscription_service_client_claims_for_the_account_and_reads_every_answer_the_contract_pins) {
  const Json::Value contract = contractFile("internal-app-store-claim.json");
  std::vector<std::string> replies;
  for (const Json::Value& example : contract["examples"])
    replies.push_back(StubService::reply(example["status"].asInt(), dump(example["body"])));
  replies.push_back(StubService::reply(200, dump(contract["examples"][0]["body"])));
  StubService service{replies};
  SubscriptionServiceClient client{ServiceAddress{service.url() + "/subscriptions", "internal-secret"}};
  const UserId account{contract["request"]["accountId"].asString()};
  const SignedTransaction signedTransaction = *SignedTransaction::read("eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.c2ln");
  const std::string segment((SignedTransaction::kBytes - 2) / 3, 'e');
  const SignedTransaction longest = *SignedTransaction::read(
      segment + "." + segment + "." + std::string(SignedTransaction::kBytes - 2 - 2 * segment.size(), 'e'));

  std::vector<std::string> answers;
  for (std::size_t asked = 0; asked + 1 < replies.size(); ++asked) {
    const ClaimAnswer answer = client.claim(account, signedTransaction);
    answers.push_back(answer.refusal ? *answer.refusal : "seq " + std::to_string(answer.seq));
  }
  client.claim(account, longest);
  CHECK(answers == (std::vector<std::string>{"seq 7", "seq 7", "bound_to_another_account", "account_erased",
                                             "invalid_transaction", "unavailable", "store_unavailable",
                                             "store_api_unavailable"}));

  const std::vector<std::string> requests = service.requests();
  REQUIRE_EQ(requests.size(), replies.size());
  Json::Value forwarded(Json::objectValue);
  forwarded["accountId"] = account.str();
  forwarded["signedTransaction"] = signedTransaction.text();
  for (std::size_t n = 0; n + 1 < requests.size(); ++n) {
    const std::string& request = requests[n];
    CHECK(request.starts_with("POST /subscriptions/internal/v1/app-store/claims HTTP/1.1\r\n"));
    CHECK(lowered(request).find("\r\nauthorization: bearer internal-secret\r\n") != std::string::npos);
    CHECK(lowered(request).find("\r\ncontent-type: application/json") != std::string::npos);
    CHECK_EQ(request.substr(request.find("\r\n\r\n") + 4), dump(forwarded));
  }
  const std::string longestBody = requests.back().substr(requests.back().find("\r\n\r\n") + 4);
  CHECK_EQ(longestBody.size(), SignedTransaction::kBytes + kClaimEnvelopeBytes);
  CHECK(longestBody.size() <= kServiceBodyBytes);
}

// The status is read before the body: a body too large for the service is a refusal of its own, the request the
// service gave up on is its `timeout`, and what the contract does not describe is no answer, named by its status, a
// body that is not one, or a service nobody listens for.
TEST(subscription_service_client_reads_the_status_before_the_body_of_a_claim_answer) {
  StubService service{{StubService::reply(413, "length limit exceeded"),
                       StubService::reply(503, R"({"error":"timeout"})"),
                       StubService::reply(502, "<html>PRIVATE_BAD_GATEWAY</html>"),
                       StubService::reply(400, R"({"code":"invalid_request"})"),
                       StubService::reply(401, R"({"code":"unauthorized"})"),
                       StubService::reply(500, R"({"code":"invalid_transaction"})"),
                       StubService::reply(409, R"({"code":"unavailable"})"),
                       StubService::reply(503, "PRIVATE_NOT_JSON"),
                       StubService::reply(200, R"({"entitlement":{}})"),
                       StubService::reply(200, R"({"seq":-1,"entitlement":{}})"),
                       StubService::reply(200, "PRIVATE_NOT_JSON")}};
  SubscriptionServiceClient client{ServiceAddress{service.url(), "internal-secret"}};
  std::string url;
  {
    StubService closed{{}};
    url = closed.url();
  }
  SubscriptionServiceClient nowhere{ServiceAddress{url, "internal-secret"}};
  const UserId account{"9387ec65-ab17-4b8c-b145-fd0d622966db"};
  const SignedTransaction signedTransaction = *SignedTransaction::read("eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.c2ln");
  const auto answerOf = [&](SubscriptionServiceClient& asked) -> std::string {
    try {
      const ClaimAnswer answer = asked.claim(account, signedTransaction);
      return answer.refusal ? "refused " + *answer.refusal : "seq";
    } catch (const ClaimUnanswered& unanswered) {
      return unanswered.answer;
    }
  };

  std::string answers;
  for (int asked = 0; asked < 11; ++asked) answers += answerOf(client) + " ";
  answers += answerOf(nowhere);
  CHECK_EQ(answers, std::string("refused too_large refused timeout 502 400 401 500 409 503 malformed malformed malformed "
                                "unreachable"));
}

TEST(subscription_service_client_erases_an_account_with_its_bearer_secret_and_only_a_204_settles_it) {
  const std::string account = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
  StubService service{{StubService::reply(204, ""), StubService::reply(404, ""), StubService::reply(200, "{}"),
                       StubService::reply(405, ""), StubService::reply(503, R"({"code":"unavailable"})"),
                       StubService::reply(401, R"({"code":"unauthorized"})")}};
  SubscriptionServiceClient client{ServiceAddress{service.url(), "internal-secret"}};

  std::string answers;
  for (int call = 0; call < 6; ++call) {
    const UnbindAnswer answer = client.unbind(UserId{account});
    answers += answer.answer + (answer.settled ? " settled " : " owed ");
  }

  CHECK_EQ(answers, std::string("204 settled 404 owed 200 owed 405 owed 503 owed 401 owed "));
  const std::vector<std::string> requests = service.requests();
  REQUIRE_EQ(requests.size(), std::size_t{6});
  CHECK_EQ(requests[0].substr(0, requests[0].find("\r\n")), "DELETE /internal/v1/accounts/" + account + " HTTP/1.1");
  CHECK(lowered(requests[0]).find("\r\nauthorization: bearer internal-secret\r\n") != std::string::npos);
}

TEST(subscription_service_client_reads_an_erasure_a_service_not_listening_never_took_as_owed) {
  std::string url;
  {
    StubService closed{{}};
    url = closed.url();
  }
  SubscriptionServiceClient client{ServiceAddress{url, "internal-secret"}};

  const UnbindAnswer answer = client.unbind(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"});

  CHECK_EQ(answer.answer + (answer.settled ? " settled" : " owed"), std::string("unreachable owed"));
}
