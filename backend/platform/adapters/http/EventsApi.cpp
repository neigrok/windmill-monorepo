#include "platform/adapters/http/EventsApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/JsonText.h"  // dump: the shared compact-JSON boundary

#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
constexpr std::size_t kMaxEventsPerCall = 50;
constexpr std::size_t kMaxNameChars = 64;
constexpr std::size_t kMaxSessionKeyChars = 64;
constexpr std::size_t kMaxPropsBytes = 1024;
// What one browser session may write in a day. It bounds a session, not an attacker — a script can
// mint a fresh session key per call, which is what the retention window and per-IP limiter are for.
constexpr int kMaxEventsPerSessionDay = 2000;

bool isSnakeName(const std::string& name) {
  if (name.empty() || name.size() > kMaxNameChars) return false;
  for (char c : name) {
    if ((c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_') return false;
  }
  return true;
}

bool isFlatProps(const Json::Value& props) {
  if (!props.isObject()) return false;
  for (const Json::Value& value : props) {
    if (value.isObject() || value.isArray()) return false;
  }
  return true;
}

// A key safe to hand libpq as a C string and index by: the beacon mints UUIDs, so the alphabet is
// strict — anything else (embedded NULs, invalid UTF-8) truncates or throws at the Postgres edge.
bool isSessionKey(const std::string& key) {
  if (key.empty() || key.size() > kMaxSessionKeyChars) return false;
  for (char c : key) {
    if ((c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_') return false;
  }
  return true;
}

// One beacon entry, or nullopt for a malformed one — a bad entry drops alone, never its siblings.
// Props must stay a flat object within the 1KB budget.
std::optional<FunnelEvent> eventOf(const Json::Value& entry) {
  if (!entry.isObject()) return std::nullopt;
  const Json::Value& name = entry["name"];
  const Json::Value& clientMs = entry["clientMs"];
  const Json::Value& props = entry["props"];
  if (!name.isString() || !isSnakeName(name.asString())) return std::nullopt;
  if (!clientMs.isNumeric()) return std::nullopt;
  const double ms = clientMs.asDouble();
  if (!std::isfinite(ms) || ms < 0 || ms > 4.0e12) return std::nullopt;  // a sane epoch-ms, not inf/garbage
  if (!props.isNull() && !isFlatProps(props)) return std::nullopt;

  FunnelEvent event;
  event.name = name.asString();
  event.clientMs = static_cast<std::int64_t>(ms);
  event.props = props.isNull() ? "{}" : dump(props);
  if (event.props.size() > kMaxPropsBytes) return std::nullopt;
  // Postgres jsonb rejects a NUL inside a string value. It would poison the whole single-txn batch,
  // so the entry drops alone here.
  if (event.props.find("\\u0000") != std::string::npos) return std::nullopt;
  return event;
}
}

EventsApi::EventsApi(std::shared_ptr<EventRepository> events, std::shared_ptr<AuthService> auth,
                     std::shared_ptr<AmplitudeClient> amplitude)
    : events_(std::move(events)), auth_(std::move(auth)), amplitude_(std::move(amplitude)) {}

void EventsApi::ingest(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The user is only ever the session's verdict — a body-supplied identity is never read.
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !json->isObject()) {
    callback(error(drogon::k400BadRequest, "a beacon batch is {sessionKey, events: [...]}"));
    return;
  }
  const Json::Value& root = *json;
  const Json::Value& sessionKey = root["sessionKey"];
  const Json::Value& entries = root["events"];
  if (!sessionKey.isString() || !isSessionKey(sessionKey.asString()) || !entries.isArray()) {
    callback(error(drogon::k400BadRequest, "a beacon batch is {sessionKey, events: [...]}"));
    return;
  }

  std::optional<UserId> caller = callerOf(req, *auth_);

  std::vector<FunnelEvent> accepted;
  for (const Json::Value& entry : entries) {
    if (accepted.size() == kMaxEventsPerCall) break;
    std::optional<FunnelEvent> event = eventOf(entry);
    if (event) accepted.push_back(std::move(*event));
  }
  if (!accepted.empty()) {
    try {
      if (events_->countInLastDay(sessionKey.asString()) >= kMaxEventsPerSessionDay) {
        callback(error(drogon::k429TooManyRequests, "this session has beaconed enough for today"));
        return;
      }
      events_->append(sessionKey.asString(), caller, accepted);
    } catch (const std::exception& e) {
      LOG_ERROR << "event batch dropped at storage: " << e.what();
      callback(error(drogon::k500InternalServerError, "events not recorded"));
      return;
    }
    // The batch is already persisted, so a throw here must not turn a stored 202 into a 500.
    if (amplitude_) {
      try {
        amplitude_->forward(sessionKey.asString(), caller, accepted);
      } catch (const std::exception& e) {
        LOG_ERROR << "amplitude forward dropped: " << e.what();
      }
    }
  }

  Json::Value body(Json::objectValue);
  body["accepted"] = static_cast<Json::UInt>(accepted.size());
  callback(jsonResponse(body, drogon::k202Accepted));
}

}
