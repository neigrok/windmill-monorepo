#include "platform/subscriptions/SubscriptionServiceClient.h"

#include "platform/adapters/json/JsonText.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>

#include <memory>
#include <stdexcept>

namespace wm::subscriptions {

namespace {
// drogon's transport verdict as a bounded word; it reports an unknown name and a refused connection alike: `unreachable`.
std::string answerFor(drogon::ReqResult result) {
  switch (result) {
    case drogon::ReqResult::Timeout: return "timeout";
    case drogon::ReqResult::BadServerAddress: return "unreachable";
    case drogon::ReqResult::BadResponse: return "bad-reply";
    case drogon::ReqResult::HandshakeError:
    case drogon::ReqResult::InvalidCertificate:
    case drogon::ReqResult::EncryptionFailure: return "tls";
    default: return "network";
  }
}

// The host's address now, its first IPv4 where it has one, as the service binds; none when the name does not resolve.
std::optional<std::string> addressOf(const std::string& host) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* found = nullptr;
  if (::getaddrinfo(host.c_str(), nullptr, &hints, &found) != 0 || !found) return std::nullopt;
  const std::unique_ptr<addrinfo, decltype(&::freeaddrinfo)> owned{found, &::freeaddrinfo};
  const addrinfo* chosen = found;
  for (const addrinfo* each = found; each; each = each->ai_next)
    if (each->ai_family == AF_INET) {
      chosen = each;
      break;
    }
  char text[INET6_ADDRSTRLEN] = {};
  const void* bytes = chosen->ai_family == AF_INET
                          ? static_cast<const void*>(&reinterpret_cast<const sockaddr_in*>(chosen->ai_addr)->sin_addr)
                          : static_cast<const void*>(&reinterpret_cast<const sockaddr_in6*>(chosen->ai_addr)->sin6_addr);
  if (!::inet_ntop(chosen->ai_family, bytes, text, sizeof text)) return std::nullopt;
  return std::string(text);
}
}

std::optional<ServiceAddress> ServiceAddress::from(const char* url, const char* token) {
  const bool hasUrl = url && *url;
  const bool hasToken = token && *token;
  if (!hasUrl && !hasToken) return std::nullopt;
  if (!hasToken) throw std::invalid_argument("SUBSCRIPTIONS_INTERNAL_TOKEN is required with SUBSCRIPTIONS_INTERNAL_URL");
  if (!hasUrl) throw std::invalid_argument("SUBSCRIPTIONS_INTERNAL_URL is required with SUBSCRIPTIONS_INTERNAL_TOKEN");
  return ServiceAddress{url, token};
}

SubscriptionServiceClient::SubscriptionServiceClient(const ServiceAddress& address) : token_(address.token) {
  std::string url = address.url;
  while (!url.empty() && url.back() == '/') url.pop_back();
  const std::size_t scheme = url.find("://");
  https_ = scheme != std::string::npos && url.compare(0, scheme, "https") == 0;
  port_ = https_ ? 443 : 80;
  const std::size_t start = scheme == std::string::npos ? 0 : scheme + 3;
  const std::size_t path = url.find('/', start);
  authority_ = url.substr(start, path == std::string::npos ? std::string::npos : path - start);
  if (path != std::string::npos) prefix_ = url.substr(path);
  // host, [v6 host] or either with :port; a port that is not one leaves the host unresolvable, so reads are unreachable.
  const std::size_t bracket = authority_.rfind(']');
  const std::size_t colon = authority_.rfind(':');
  host_ = authority_;
  if (colon != std::string::npos && (bracket == std::string::npos || colon > bracket)) {
    host_ = authority_.substr(0, colon);
    try {
      port_ = static_cast<std::uint16_t>(std::stoul(authority_.substr(colon + 1)));
    } catch (const std::exception&) {
      host_.clear();
    }
  }
  if (host_.size() > 1 && host_.front() == '[' && host_.back() == ']') host_ = host_.substr(1, host_.size() - 2);
  loop_.run();
}

void SubscriptionServiceClient::stop() {
  std::call_once(stopped_, [this] {
    loop_.run();
    auto* loop = loop_.getLoop();
    loop->queueInLoop([loop] { loop->quit(); });
    loop_.wait();
  });
}

FeedPage SubscriptionServiceClient::page(Seq after, int limit) {
  const std::optional<std::string> address = host_.empty() ? std::nullopt : addressOf(host_);
  if (!address) throw FeedUnavailable("unreachable");
  auto client = drogon::HttpClient::newHttpClient(*address, port_, https_, loop_.getLoop());
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(prefix_ + "/internal/v1/feed");
  request->setParameter("after", std::to_string(after));
  request->setParameter("limit", std::to_string(limit));
  request->addHeader("host", authority_);
  request->addHeader("authorization", "Bearer " + token_);

  const auto [result, response] = client->sendRequest(request, kTimeoutSeconds);
  if (result != drogon::ReqResult::Ok) throw FeedUnavailable(answerFor(result));
  if (!response) throw FeedUnavailable("bad-reply");
  const int status = static_cast<int>(response->getStatusCode());
  if (status < 200 || status >= 300) throw FeedUnavailable(std::to_string(status));
  const std::optional<Json::Value> body = parseWhole(std::string(response->getBody()));
  if (!body) throw FeedUnavailable("malformed");
  return FeedPage{*body};
}

UnbindAnswer SubscriptionServiceClient::unbind(const UserId& account) {
  const std::optional<std::string> address = host_.empty() ? std::nullopt : addressOf(host_);
  if (!address) return UnbindAnswer{false, "unreachable"};
  auto client = drogon::HttpClient::newHttpClient(*address, port_, https_, loop_.getLoop());
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Delete);
  request->setPath(prefix_ + "/internal/v1/accounts/" + account.str());
  request->addHeader("host", authority_);
  request->addHeader("authorization", "Bearer " + token_);

  const auto [result, response] = client->sendRequest(request, kTimeoutSeconds);
  if (result != drogon::ReqResult::Ok) return UnbindAnswer{false, answerFor(result)};
  if (!response) return UnbindAnswer{false, "bad-reply"};
  const int status = static_cast<int>(response->getStatusCode());
  return UnbindAnswer{(status >= 200 && status < 300) || status == 404, std::to_string(status)};
}

}
