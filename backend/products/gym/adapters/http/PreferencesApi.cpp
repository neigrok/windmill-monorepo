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

// The one read in gym that cannot 404: a lifter with no row is answered with the DEFAULTS, because
// every client needs the rest target and the reading unit before it can draw a first frame. Nothing
// is written on the way out.
void PreferencesApi::preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(preferences_->preferences(*caller))));
}

// Written as the WHOLE document: a field the body does not name takes its default, and there is no
// partial write to reconcile.
// UNITS REACH NOTHING. `lb` is stored as the lifter's reading unit and changes no column, no wire
// number and no rule — every load in this product is kilograms.
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
  // The codec builds the entity, so every refusal below is a value the store could not have held,
  // each carrying the machine word for the row to send the lifter back to. The wider catch keeps a
  // domain refusal from riding out as the house 500 the phones' queues retry forever.
  try {
    cb(jsonResponse(toJson(preferences_->savePreferences(parsePreferences(*json, *caller)))));
  } catch (const InvalidPreference& refused) {
    cb(error(drogon::k400BadRequest, refused.what(), refused.code.c_str()));
  } catch (const InvalidTraining& malformed) {
    cb(error(drogon::k400BadRequest, malformed.what(), "preferences-unreadable"));
  }
}

}
