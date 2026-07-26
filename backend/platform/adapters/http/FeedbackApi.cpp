#include "platform/adapters/http/FeedbackApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <optional>
#include <string>
#include <utility>

namespace wm {

namespace {
constexpr std::size_t kMaxMessageBytes = 2000;
constexpr std::size_t kMaxSideBytes = 200;
constexpr std::size_t kMaxSessionKeyChars = 64;

std::string trim(const std::string& text) {
  const char* whitespace = " \t\n\r\f\v";
  std::size_t begin = text.find_first_not_of(whitespace);
  if (begin == std::string::npos) return "";
  std::size_t end = text.find_last_not_of(whitespace);
  return text.substr(begin, end - begin + 1);
}

// Cut to at most maxBytes without splitting a UTF-8 sequence, so the plain-text column never
// sees an invalid byte run at the boundary.
std::string truncate(const std::string& text, std::size_t maxBytes) {
  if (text.size() <= maxBytes) return text;
  std::size_t cut = maxBytes;
  while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;
  return text.substr(0, cut);
}

// The correlation key only: same strict alphabet as the event-spine — anything else is
// dropped to empty (stored as null), never rejected. It is not identity.
bool isSessionKey(const std::string& key) {
  if (key.empty() || key.size() > kMaxSessionKeyChars) return false;
  for (char c : key) {
    if ((c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_') return false;
  }
  return true;
}
}

FeedbackApi::FeedbackApi(std::shared_ptr<FeedbackRepository> feedback, std::shared_ptr<AuthService> auth)
    : feedback_(std::move(feedback)), auth_(std::move(auth)) {}

void FeedbackApi::submit(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Parse the envelope, require a non-empty in-bounds message, truncate the optional side
  // fields, resolve the caller, store. Identity is only ever the session's verdict.
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !json->isObject()) {
    callback(error(drogon::k400BadRequest, "feedback is {message, email?, context?}"));
    return;
  }
  const Json::Value& root = *json;

  const Json::Value& message = root["message"];
  if (!message.isString()) {
    callback(error(drogon::k400BadRequest, "message is required"));
    return;
  }
  std::string trimmed = trim(message.asString());
  if (trimmed.empty() || trimmed.size() > kMaxMessageBytes) {
    callback(error(drogon::k400BadRequest, "message must be 1-2000 characters"));
    return;
  }

  const Json::Value& emailValue = root["email"];
  const Json::Value& contextValue = root["context"];
  std::string email = emailValue.isString() ? truncate(emailValue.asString(), kMaxSideBytes) : "";
  std::string context = contextValue.isString() ? truncate(contextValue.asString(), kMaxSideBytes) : "";

  const Json::Value& sessionKeyValue = root["sessionKey"];
  std::string sessionKey =
      (sessionKeyValue.isString() && isSessionKey(sessionKeyValue.asString())) ? sessionKeyValue.asString() : "";

  std::optional<UserId> caller = callerOf(req, *auth_);

  try {
    feedback_->insert(sessionKey, caller, trimmed, email, context);
  } catch (const std::exception& e) {
    LOG_ERROR << "feedback dropped at storage: " << e.what();
    callback(error(drogon::k500InternalServerError, "feedback not recorded"));
    return;
  }

  Json::Value body(Json::objectValue);
  body["ok"] = true;
  callback(jsonResponse(body, drogon::k202Accepted));
}

}
