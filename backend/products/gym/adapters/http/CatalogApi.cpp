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

void CatalogApi::createExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  ExerciseInsertOutcome outcome{std::nullopt, ExerciseInsertError::none};
  try {
    outcome = catalog_->createExercise(*caller, parseExerciseWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that movement"));
    return;
  }
  if (outcome.error == ExerciseInsertError::idTaken) {
    // A seed slug and another lifter's id are one answer; the caller's own id replays instead.
    cb(error(drogon::k409Conflict, "that movement id is taken", "exercise-id-taken"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.exercise)));
}

// The movement keeps its id. A caller's own movement renames in place; a seed takes a per-account
// display name, since seed rows are global.
void CatalogApi::renameExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  std::optional<Exercise> renamed;
  try {
    renamed = catalog_->renameExercise(*caller, ExerciseId{id}, parseExerciseRename(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that name"));
    return;
  }
  if (!renamed) {
    // Absent and another lifter's private movement are one answer.
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*renamed)));
}

// A movement nobody has lifted answers 200 with zeroed counts; the 404 means no such movement.
void CatalogApi::exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
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
}

}
