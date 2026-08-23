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

// A routine is written as its WHOLE document — create and replace send the same body — so nothing
// here edits a line, reorders one, or reconciles a partial update.
void ProgramApi::listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  // The pending proposals ride on the list rather than on a second call per routine.
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
    // No door: this route is the lifter's own hand, which the routine's history says by saying
    // nothing about who made it.
    outcome = program_->createRoutine(*caller, parseRoutineWrite(*json), std::nullopt);
  } catch (const InvalidTraining&) {
    // One sentence for every way a routine can be unstorable as written.
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::idTaken) {
    // A fact about an id and never about an owner. Its own replay is not this refusal — it answers
    // with the routine already stored.
    cb(error(drogon::k409Conflict, "that routine id is taken", "routine-id-taken"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    // The same fact a set naming no known movement gets, under the same machine word.
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
  // Newest first, so the first is the one a card draws when two doors each have one waiting. Its
  // OWN read and not the pending row of the bounded history below, which a still-waiting proposal
  // from a quiet door can fall outside of.
  std::optional<ProposalHead> pending;
  for (const ProposalHead& head : program_->proposals(*caller, ProposalQuery{RoutineId{id}, true}))
    if (!pending) pending = head;
  // The History section rides on this read and not on a route of its own. The LIST read carries
  // none of it.
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
  // The PATH names the routine being replaced; where the body's id could disagree, the URL is what
  // the store is asked for.
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
    // Only a PUT that named the revision it read can earn this: the day moved under the editor.
    // The remedy is a re-read, so the code says so.
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
  // Every session trained under this routine keeps its frozen snapshot, so deleting the plan never
  // edits what the log says about the past.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// The proposal ledger, over four handlers. They are HTTP and nothing else: Apply stays in the hand,
// so no MCP tool reaches these at any grant level and `GymToolsTest` pins the absence by name.
// One list read serves the three questions the surfaces ask — every pending proposal on the account,
// one routine's whole run including its settled history, and one routine's pending. A settled
// proposal stays in that list.
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

// The diff screen's whole read, and the one a deep link from an agent's receipt lands on. Absent,
// another account's and never-existed are the one answer.
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

// The tap. All of it or none: the domain computes the routine the proposal makes true and the store
// writes it in one transaction against the frozen base revision.
// The answer carries BOTH the settled proposal and the routine as it now stands. The routine is
// absent for a removal, because there is no longer one.
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

// Nothing changes: it stays in the routine's history, which is why this is a settle and not a
// delete.
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
