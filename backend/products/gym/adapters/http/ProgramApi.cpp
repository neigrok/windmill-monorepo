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

// The plan, over four handlers that share one shape. A routine is written as its WHOLE document —
// create and replace send the same body, and the editor's every change is a read-modify-write of it
// — so nothing here edits a line, reorders one, or reconciles a partial update against a store that
// moved underneath it.
void ProgramApi::listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  // The dot §B5 draws beside a day of the program rides on the list rather than on a second call
  // per routine — the same N+1 the log read refused when it made its summary carry its own facts.
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
    // No door: this route is a lifter's own hand on their own phone, which is the whole of §M's
    // third door and what the routine's history says by saying nothing about who made it.
    outcome = program_->createRoutine(*caller, parseRoutineWrite(*json), std::nullopt);
  } catch (const InvalidTraining&) {
    // One sentence for every way a routine can be unstorable as written: no entries, a name that is
    // empty or over eighty characters, a position out of range, an entry outside its bounds.
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::idTaken) {
    // Spent by an account this caller cannot see, so it is a fact about an id and never about an
    // owner. Its own replay is not this refusal — it answers with the routine already stored.
    cb(error(drogon::k409Conflict, "that routine id is taken", "routine-id-taken"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    // The same fact a set naming no known movement gets, under the same machine word: the entry has
    // to be resolved against GET /v1/gym/exercises before the plan can hold it.
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
  // Newest first, so the first is the one a card draws when two doors each have one waiting. It is
  // its OWN read and not the pending row of the history below, however alike the two look: the
  // history is a bounded window of the newest rows, and a proposal from a quiet door can be older
  // than that window while still waiting. A dot that vanished once a day had twenty newer settled
  // proposals would be the product hiding a decision the lifter still has to make.
  std::optional<ProposalHead> pending;
  for (const ProposalHead& head : program_->proposals(*caller, ProposalQuery{RoutineId{id}, true}))
    if (!pending) pending = head;
  // The History section (§M30) rides on this read and not on a route of its own, because it is one
  // section of the screen this read already draws — and a screen that fetched its history separately
  // would draw the day, then the day's past, in two frames. The LIST read carries none of it: a
  // routines screen prints names.
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
  // The PATH names the routine being replaced — a read-modify-write sends back the id it read, so
  // the two always agree, and where they could not the URL is what the store was asked for.
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
  // Nothing to say and no body to say it in. Every session ever trained under this routine keeps its
  // frozen snapshot, so deleting the plan never edits what the log says about the past.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// THE PROPOSAL LEDGER, over four handlers, and the last two are the tap §D14 draws. They are HTTP
// and nothing else on purpose: the tool layer is the only place gym can tell an agent from a hand,
// and Apply is the one act this whole design exists to keep in the hand. No MCP tool reaches these
// at any grant level, and `GymToolsTest` pins the absence by name so no wave can "complete the
// catalog" here without deleting §D from the product.
//
// One list read serves the three questions the surfaces ask — every pending proposal on the account
// (Today's card), one routine's whole run including its settled history (the routine editor's
// History section), and one routine's pending (the dot). A settled proposal stays in that list
// forever, because an agent's suggestion is part of the program's history rather than a toast that
// disappears.
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
// another account's and never-existed are the one answer, exactly as every other read here.
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

// The tap. All of it or none — the domain computes the routine the proposal makes true and the
// store writes it in one transaction against the frozen base revision — so there is no half-applied
// state for a client to reconcile and no partial reply to draw.
//
// The answer carries BOTH: the settled proposal (so the card can redraw as `Applied` with its
// timestamp and stay) and the routine as it now stands (so the editor behind it redraws without a
// second read). The routine is absent for a removal, because there is no longer one.
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
    // Unreachable through the mint, which builds the document through the Routine constructor
    // before anything is stored — and kept because the alternative is a 500 on the one tap this
    // product cannot afford to fail opaquely.
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

// No reason is asked for and nothing changes. It stays in the routine's history in case the lifter
// wants it back, which is why this is a settle rather than a delete.
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
