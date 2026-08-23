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

// The movement a lifter creates from the picker. It is theirs alone — created_by is the owner, and
// the catalog read serves the seeds plus the caller's own.
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
    // A seed's slug or another lifter's custom id, told apart by nobody: mint a new id and send it
    // again. The caller's OWN id is not this refusal — it replays with the movement stored under it.
    cb(error(drogon::k409Conflict, "that movement id is taken", "exercise-id-taken"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.exercise)));
}

// The movement keeps its id, so every set, routine entry and frozen plan snapshot still names it.
// A movement the caller created renames in place; a SEED takes a per-account display name, because
// the seeds are global rows and renaming one in place would rename it for every lifter.
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
    // Absent and another lifter's private movement are the one fact.
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*renamed)));
}

// A movement's record: one page off a single call — the tiles, the bars, the record ladder and the
// recent days. Every number is computed from stored rows on this call and kept nowhere. A movement
// nobody has lifted answers 200 with its counts at zero and no lists at all; the 404 below is the
// different sentence "no such movement".
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
