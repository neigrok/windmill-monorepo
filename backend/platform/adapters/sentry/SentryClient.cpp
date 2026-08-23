#include "platform/adapters/sentry/SentryClient.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <chrono>
#include <random>
#include <utility>

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

// A batch leaves when it fills or when the timer fires, whichever comes first: the cap bounds the
// envelope, the interval bounds how long a line waits to become visible during an incident.
constexpr std::size_t kLogBatch = 100;
constexpr std::size_t kLogBufferCap = 2000;
constexpr double kLogFlushSeconds = 5.0;

const char* levelName(SentryClient::Level level) {
  switch (level) {
    case SentryClient::Level::trace: return "trace";
    case SentryClient::Level::debug: return "debug";
    case SentryClient::Level::info: return "info";
    case SentryClient::Level::warn: return "warn";
    case SentryClient::Level::error: return "error";
    case SentryClient::Level::fatal: return "fatal";
  }
  return "info";
}

// Sentry's log attributes are typed, not bare scalars: { "value": …, "type": "string" }.
Json::Value stringAttribute(std::string value) {
  Json::Value attribute(Json::objectValue);
  attribute["value"] = std::move(value);
  attribute["type"] = "string";
  return attribute;
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
  if (!enabled_) return;
  runTraceId_ = hex32();
  // One client for the life of the process, not one per envelope.
  client_ = drogon::HttpClient::newHttpClient("https://" + host_, loop_.getLoop());
  // The timer is what makes a quiet server still report: a batch that never fills would sit in memory.
  loop_.getLoop()->runEvery(kLogFlushSeconds, [this] { flushLogs(); });
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
  post(Json::writeString(builder, envelopeHeader) + "\n" + Json::writeString(builder, itemHeader) +
       "\n" + Json::writeString(builder, event));
}

// One envelope, one POST. Events and logs differ only in the items above this line.
void SentryClient::post(std::string body) {
  if (!client_) return;
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/api/" + projectId_ + "/envelope/");
  req->addHeader("x-sentry-auth",
                 "Sentry sentry_version=7, sentry_client=windmill-server/1.0, sentry_key=" + publicKey_);
  req->setContentTypeString("application/x-sentry-envelope");
  req->setBody(body);

  // Async on the private loop: the calling handler thread is freed the instant this returns, and a
  // failed report only logs — it can never re-enter the exception path it was reporting.
  client_->sendRequest(
      req,
      [](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300)
          LOG_ERROR << "Sentry capture failed (status " << status << ")";
      },
      10.0);
}

bool SentryClient::onReportingThread() const {
  return enabled_ && loop_.getLoop() && loop_.getLoop()->isInLoopThread();
}

void SentryClient::log(Level level, std::string body, std::string source) {
  if (!enabled_ || body.empty()) return;

  Json::Value item(Json::objectValue);
  item["timestamp"] =
      std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  item["trace_id"] = runTraceId_;
  item["level"] = levelName(level);
  item["body"] = std::move(body);
  Json::Value attributes(Json::objectValue);
  attributes["sentry.environment"] = stringAttribute(environment_);
  if (!release_.empty()) attributes["sentry.release"] = stringAttribute(release_);
  // The file:line trantor appends is metadata, not prose: in the body it would defeat Sentry's grouping.
  if (!source.empty()) attributes["code.location"] = stringAttribute(std::move(source));
  item["attributes"] = std::move(attributes);

  bool full = false;
  {
    std::lock_guard<std::mutex> lock(logMutex_);
    // The buffer is a ceiling: what is dropped is counted and reported on the next flush.
    if (logItems_.size() >= kLogBufferCap) {
      ++logDropped_;
      return;
    }
    logItems_.push_back(std::move(item));
    full = logItems_.size() >= kLogBatch;
  }
  if (full) loop_.getLoop()->queueInLoop([this] { flushLogs(); });
}

void SentryClient::flushLogs() {
  std::vector<Json::Value> batch;
  std::int64_t dropped = 0;
  {
    std::lock_guard<std::mutex> lock(logMutex_);
    if (logItems_.empty() && logDropped_ == 0) return;
    batch.swap(logItems_);
    dropped = std::exchange(logDropped_, 0);
  }

  Json::Value items(Json::arrayValue);
  for (Json::Value& item : batch) items.append(std::move(item));
  if (dropped > 0) {
    Json::Value note(Json::objectValue);
    note["timestamp"] =
        std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
    note["trace_id"] = runTraceId_;
    note["level"] = "warn";
    note["body"] = "windmill log buffer overflowed — " + std::to_string(dropped) + " line(s) dropped";
    note["attributes"]["sentry.environment"] = stringAttribute(environment_);
    items.append(std::move(note));
  }

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  Json::Value payload(Json::objectValue);
  payload["items"] = std::move(items);
  const std::string encoded = Json::writeString(builder, payload);

  Json::Value envelopeHeader(Json::objectValue);
  Json::Value itemHeader(Json::objectValue);
  itemHeader["type"] = "log";
  itemHeader["item_count"] = static_cast<Json::UInt64>(payload["items"].size());
  itemHeader["content_type"] = "application/vnd.sentry.items.log+json";
  itemHeader["length"] = static_cast<Json::UInt64>(encoded.size());
  post(Json::writeString(builder, envelopeHeader) + "\n" + Json::writeString(builder, itemHeader) +
       "\n" + encoded);
}

}
