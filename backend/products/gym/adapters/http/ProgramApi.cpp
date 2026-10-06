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

}
