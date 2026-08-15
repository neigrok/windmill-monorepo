#include "products/gym/adapters/http/CatalogApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::gym {

CatalogApi::CatalogApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth)
    : log_(std::move(log)), auth_(std::move(auth)) {}

void CatalogApi::listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["exercises"] = toJson(log_->catalog(*caller));
  cb(jsonResponse(body));
}

// The movement a lifter creates from the picker, off "no movement by that name". It is theirs
// alone — created_by is the owner, and the catalog read only ever serves the seeds plus the
// caller's own — so the reply is the row every later set and routine entry points at by id.
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
    outcome = log_->createExercise(*caller, parseExerciseWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that movement"));
    return;
  }
  if (outcome.error == ExerciseInsertError::idTaken) {
    // A seed's slug or another lifter's custom id, told apart by nobody: mint a new id and send it
    // again. The caller's OWN id is not this refusal — it replays, answering with the movement
    // already stored under it, because the alternative is what §2.1 exists to prevent: a lost reply
    // re-minted into a second "Zercher Squat" that every later set then forks history across.
    cb(error(drogon::k409Conflict, "that movement id is taken", "exercise-id-taken"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.exercise)));
}

// The rename, and the whole point of stable exercise identity made visible: the movement keeps its
// id, so every set, every routine entry and every frozen plan snapshot still names it and the
// history stays whole. What the store does under this depends on whose row it is — a movement the
// caller created renames in place, a SEED takes a per-account display name, because the 64 seeds
// are global rows and renaming one in place would rename it for every lifter on the server.
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
    renamed = log_->renameExercise(*caller, ExerciseId{id}, parseExerciseRename(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that name"));
    return;
  }
  if (!renamed) {
    // The path names a movement this account's catalog does not hold. Absent and another lifter's
    // private movement are the one fact, exactly as an absent session is.
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*renamed)));
}

// A movement's record: one exercise, one page, and one read behind it — the two tiles, the twelve
// weeks of bars, the record ladder and the recent days all come off a single call, because a page
// that made a request per tile is a page that draws in four stages. Every number in it is computed
// from stored rows on this call and kept nowhere, the rule every read surface in this product
// obeys. A movement in the catalog nobody has lifted answers 200 with its counts at zero and no
// lists at all — that is a fact, not a fault, and it is what the picker's `never logged` is drawn
// from; the 404 below is the different sentence "no such movement".
void CatalogApi::exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<MovementRecord> record = log_->movementRecord(*caller, ExerciseId{id});
  if (!record) {
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*record)));
}

}
