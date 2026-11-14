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
// canned reply and closed, and each request's bytes are kept. A connection that never comes is given up after 5 s.
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
        while (request.find("\r\n\r\n") == std::string::npos) {
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
  CHECK_EQ(read.latestSeq, Seq{26});
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
