#include "products/gym/adapters/http/PreferencesApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

PreferencesApi::PreferencesApi(std::shared_ptr<PreferencesService> preferences,
                               std::shared_ptr<AuthService> auth)
    : preferences_(std::move(preferences)), auth_(std::move(auth)) {}

// A lifter with no row is answered with the defaults; nothing is written on the way out.
void PreferencesApi::preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(preferences_->preferences(*caller))));
}

// The whole document: a field the body does not name takes its default. `lb` is a reading unit only —
// every stored and wire load is kilograms.
void PreferencesApi::savePreferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json", "preferences-unreadable"));
    return;
  }
  // A domain refusal must not ride out as a 500: the phones' queues retry those forever.
  try {
    cb(jsonResponse(toJson(preferences_->savePreferences(parsePreferences(*json, *caller)))));
  } catch (const InvalidPreference& refused) {
    cb(error(drogon::k400BadRequest, refused.what(), refused.code.c_str()));
  } catch (const InvalidTraining& malformed) {
    cb(error(drogon::k400BadRequest, malformed.what(), "preferences-unreadable"));
  }
}

}
