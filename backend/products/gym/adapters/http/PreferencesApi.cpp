#include "products/gym/adapters/http/PreferencesApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/GymJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

PreferencesApi::PreferencesApi(std::shared_ptr<PreferencesRepository> preferences,
                               std::shared_ptr<AuthService> auth)
    : preferences_(std::move(preferences)), auth_(std::move(auth)) {}

// A lifter with no row is answered with the defaults; nothing is written on the way out.
void PreferencesApi::preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(preferences_->preferences(*caller).value_or(GymPreferences{*caller}))));
}

}
