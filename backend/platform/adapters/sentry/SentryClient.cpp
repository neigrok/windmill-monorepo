#include "platform/adapters/sentry/SentryClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <random>

namespace wm {

namespace {
// Parse a Sentry DSN "https://{publicKey}@{host}/{projectId}" into its parts.
bool parseDsn(const std::string& dsn, std::string& host, std::string& projectId, std::string& publicKey) {
  const std::string scheme = "https://";
  if (dsn.rfind(scheme, 0) != 0) return false;
  const std::string rest = dsn.substr(scheme.size());
  const auto at = rest.find('@');
  if (at == std::string::npos) return false;
  publicKey = rest.substr(0, at);
  const std::string hostAndProject = rest.substr(at + 1);
  const auto slash = hostAndProject.rfind('/');
  if (slash == std::string::npos) return false;
  host = hostAndProject.substr(0, slash);
  projectId = hostAndProject.substr(slash + 1);
  return !publicKey.empty() && !host.empty() && !projectId.empty();
}

std::string hex32() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<int> nibble(0, 15);
  static const char* digits = "0123456789abcdef";
  std::string out(32, '0');
  for (char& c : out) c = digits[nibble(rng)];
  return out;
}
}

SentryClient::SentryClient(const std::string& dsn, std::string environment, std::string release)
    : environment_(std::move(environment)), release_(std::move(release)) {
  enabled_ = parseDsn(dsn, host_, projectId_, publicKey_);
  loop_.run();
}

bool SentryClient::allow() {
  static constexpr int kMaxPerMinute = 60;
  const std::int64_t now =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  std::lock_guard<std::mutex> lock(rateMutex_);
  if (now - windowStartMs_ > 60000) {
    windowStartMs_ = now;
    windowCount_ = 0;
  }
  if (windowCount_ >= kMaxPerMinute) return false;
  ++windowCount_;
  return true;
}

Json::Value SentryClient::newEvent(const std::string& id, const std::string& kind) const {
  Json::Value event(Json::objectValue);
  event["event_id"] = id;
  event["timestamp"] = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  event["platform"] = "other";
  event["level"] = "error";
  event["logger"] = "windmill-server";
  event["environment"] = environment_;
  if (!release_.empty()) event["release"] = release_;
  event["tags"]["kind"] = kind;
  return event;
}

void SentryClient::report(const std::string& kind, const std::string& where,
                          const std::string& detail) {
  if (!enabled_ || !allow()) return;
  const std::string id = hex32();
  Json::Value event = newEvent(id, kind);
  event["transaction"] = where;
  // Grouped by the operation that failed, with the reason as the readable body. `detail` is
  // metadata by contract (ports/FailureReporter) — never anything the user wrote.
  event["message"]["formatted"] = where + ": " + detail;
  ship(id, event);
}

void SentryClient::captureException(const std::string& kind, const std::string& method,
                                    const std::string& path, const std::string& message) {
  if (!enabled_ || !allow()) return;

  const std::string id = hex32();
  Json::Value event = newEvent(id, kind);
  event["transaction"] = method + " " + path;
  event["request"]["method"] = method;
  event["request"]["url"] = path;
  Json::Value value(Json::objectValue);
  value["type"] = kind.empty() ? std::string("Exception") : kind;
  value["value"] = message;
  event["exception"]["values"].append(value);
  ship(id, event);
}

void SentryClient::ship(const std::string& id, const Json::Value& event) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  Json::Value envelopeHeader(Json::objectValue);
  envelopeHeader["event_id"] = id;
  Json::Value itemHeader(Json::objectValue);
  itemHeader["type"] = "event";
  const std::string body = Json::writeString(builder, envelopeHeader) + "\n" +
                           Json::writeString(builder, itemHeader) + "\n" +
                           Json::writeString(builder, event);

  auto client = drogon::HttpClient::newHttpClient("https://" + host_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/api/" + projectId_ + "/envelope/");
  req->addHeader("x-sentry-auth",
                 "Sentry sentry_version=7, sentry_client=windmill-server/1.0, sentry_key=" + publicKey_);
  req->setContentTypeString("application/x-sentry-envelope");
  req->setBody(body);

  // Async on the private loop: the calling handler thread is freed the instant this returns, and a
  // failed report only logs — it can never re-enter the exception path it was reporting.
  client->sendRequest(
      req,
      [client](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300)
          LOG_ERROR << "Sentry capture failed (status " << status << ")";
      },
      10.0);
}

}
