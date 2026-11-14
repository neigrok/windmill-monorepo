#include "platform/subscriptions/SubscriptionServiceClient.h"

#include "platform/adapters/json/JsonText.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <stdexcept>

namespace wm::subscriptions {

namespace {
// drogon's transport verdict as a bounded word. It reports a name that does not resolve and a connection refused alike,
// so both read `unreachable`.
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
  // drogon dials an origin and ignores everything after it, so a path prefix is kept apart.
  const std::size_t scheme = url.find("://");
  const std::size_t path = scheme == std::string::npos ? url.find('/') : url.find('/', scheme + 3);
  origin_ = url.substr(0, path);
  if (path != std::string::npos) prefix_ = url.substr(path);
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
  auto client = drogon::HttpClient::newHttpClient(origin_, loop_.getLoop());
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(prefix_ + "/internal/v1/feed");
  request->setParameter("after", std::to_string(after));
  request->setParameter("limit", std::to_string(limit));
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

}
