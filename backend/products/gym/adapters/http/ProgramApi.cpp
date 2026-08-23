#include "products/gym/adapters/http/ProgramApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::gym {

ProgramApi::ProgramApi(std::shared_ptr<ProgramService> program, std::shared_ptr<AuthService> auth)
    : program_(std::move(program)), auth_(std::move(auth)) {}

// A routine is written as its whole document: create and replace take the same body.
void ProgramApi::listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["routines"] = toJson(program_->routines(*caller),
                            program_->proposals(*caller, ProposalQuery{std::nullopt, true}));
  cb(jsonResponse(body));
}

void ProgramApi::createRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
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
  RoutineWriteOutcome outcome{std::nullopt, RoutineWriteError::none};
  try {
    outcome = program_->createRoutine(*caller, parseRoutineWrite(*json), std::nullopt);
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::idTaken) {
    // About the id and never the owner; the caller's own id replays with the stored routine instead.
    cb(error(drogon::k409Conflict, "that routine id is taken", "routine-id-taken"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.routine)));
}

void ProgramApi::getRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<Routine> routine = program_->routine(*caller, RoutineId{id});
  if (!routine) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  // Newest first, so the first pending head is the one a card draws.
  std::optional<ProposalHead> pending;
  for (const ProposalHead& head : program_->proposals(*caller, ProposalQuery{RoutineId{id}, true}))
    if (!pending) pending = head;
  Json::Value body = toJson(*routine, pending);
  body["history"] = toJson(program_->routineHistory(*caller, RoutineId{id}));
  cb(jsonResponse(body));
}

void ProgramApi::replaceRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
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
  // The path names the routine replaced; a body id that disagrees is ignored.
  RoutineWriteOutcome outcome{std::nullopt, RoutineWriteError::none};
  try {
    outcome = program_->replaceRoutine(*caller, RoutineId{id}, parseRoutineWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::notFound) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  if (outcome.error == RoutineWriteError::stale) {
    // Only a PUT that named the revision it read can reach this.
    cb(error(drogon::k409Conflict, "that routine changed since you read it — reload it and save again",
             "routine-stale"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.routine)));
}

void ProgramApi::deleteRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!program_->deleteRoutine(*caller, RoutineId{id})) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  // Sessions trained under this routine keep their frozen snapshot.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// One read serves all three questions; a settled proposal stays in the list.
void ProgramApi::listProposals(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  ProposalQuery query;
  const std::string routine = req->getParameter("routineId");
  if (!routine.empty()) query.routine = RoutineId{routine};
  query.pendingOnly = req->getParameter("state") == "pending";
  Json::Value body(Json::objectValue);
  body["proposals"] = toJson(program_->proposals(*caller, query));
  cb(jsonResponse(body));
}

// Absent, another account's and never-existed are one answer.
void ProgramApi::getProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<RoutineProposal> held = program_->proposal(*caller, ProposalId{id});
  if (!held) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// All of it or none: one transaction against the frozen base revision. The reply carries the settled
// proposal and the routine as it now stands; the routine is absent for a removal.
void ProgramApi::applyProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  ProposalSettleOutcome outcome{std::nullopt, std::nullopt, ProposalSettleError::none};
  try {
    outcome = program_->apply(*caller, ProposalId{id});
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not apply that proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::notFound) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::superseded) {
    cb(error(drogon::k409Conflict,
             "that routine changed after this proposal was written, so it was not applied",
             "proposal-superseded"));
    return;
  }
  if (outcome.error == ProposalSettleError::settled) {
    cb(error(drogon::k409Conflict, "that proposal was already dismissed", "proposal-settled"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["proposal"] = toJson(*outcome.proposal);
  if (outcome.routine) body["routine"] = toJson(*outcome.routine);
  cb(jsonResponse(body));
}

// A settle, not a delete: the proposal stays in the routine's history.
void ProgramApi::dismissProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                             const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const ProposalSettleOutcome outcome = program_->dismiss(*caller, ProposalId{id});
  if (outcome.error == ProposalSettleError::notFound) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::superseded) {
    cb(error(drogon::k409Conflict,
             "that routine changed after this proposal was written, so there is nothing left to "
             "dismiss",
             "proposal-superseded"));
    return;
  }
  if (outcome.error == ProposalSettleError::settled) {
    cb(error(drogon::k409Conflict, "that proposal was already applied", "proposal-settled"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["proposal"] = toJson(*outcome.proposal);
  cb(jsonResponse(body));
}

}
