#include "products/gym/adapters/http/CatalogApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::gym {

CatalogApi::CatalogApi(std::shared_ptr<CatalogService> catalog,
                       std::shared_ptr<TrainingService> training, std::shared_ptr<AuthService> auth)
    : catalog_(std::move(catalog)), training_(std::move(training)), auth_(std::move(auth)) {}

void CatalogApi::listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["exercises"] = toJson(catalog_->catalog(*caller));
  cb(jsonResponse(body));
}

// A movement nobody has lifted answers 200 with zeroed counts; the 404 means no such movement.
void CatalogApi::exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) try {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<MovementRecord> record = training_->movementRecord(*caller, ExerciseId{id});
  if (!record) {
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*record)));
} catch (const GymUnavailable& unavailable) {
  cb(error(drogon::k503ServiceUnavailable, unavailable.what(), unavailable.code.c_str()));
}

}
