#include "products/gym/adapters/http/PreferencesApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

PreferencesApi::PreferencesApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth)
    : log_(std::move(log)), auth_(std::move(auth)) {}

// The statistics ENGINE, over values the domain already decides: a per-movement line of top working
// sets with Epley on top, the two standing bests, when each movement was last trained, and the
// weekly counts. It takes no parameters at all — no window, no movement filter, no page — because
// the whole point of it is the long view, and every number in it is a fact with a direction rather
// than a grade.
//
// No app screen reads this route: W1c retired the statistics room on all three surfaces and put a
// movement's record (`GET /v1/gym/exercises/{id}/record`) where a lifter goes instead. It stays for
// the reader it was always best for — an agent through `get_stats`, asking how a lift has moved
// (domain/Statistics.h). Unreached by a tab is not unreachable.
// §I's rows, read. It is the one read in gym that cannot 404: a lifter who has never opened this
// screen holds no row and is answered with the DEFAULTS, because every client needs the rest target
// and the reading unit before it can draw a first frame. Nothing is written on the way out.
void PreferencesApi::preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(log_->preferences(*caller))));
}

// And written — the WHOLE document, the shape a routine travels in, because the screen renders all
// every row from one value it already holds. A field the body does not name takes its default;
// there is no partial write, so nothing here has to reconcile one against a store that moved.
//
// UNITS REACH NOTHING. `lb` is stored as the lifter's reading unit and changes no column, no wire
// number and no rule in this product: kilograms are what a set weighs here and always were, and
// this route is the only place in gym that has ever heard of another unit.
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
  // The codec builds the entity, so every refusal below is a value the store could not have held —
  // and each carries the machine word that says which row to send the lifter back to.
  // The wider catch is the owner's, which no signed-in caller can trip; it keeps a domain refusal
  // from riding out as the house 500 the phones' queues are told to retry forever.
  try {
    cb(jsonResponse(toJson(log_->savePreferences(parsePreferences(*json, *caller)))));
  } catch (const InvalidPreference& refused) {
    cb(error(drogon::k400BadRequest, refused.what(), refused.code.c_str()));
  } catch (const InvalidTraining& malformed) {
    cb(error(drogon::k400BadRequest, malformed.what(), "preferences-unreadable"));
  }
}

}
