#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/ProgramService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// `routine-id-taken` is repaired by minting a fresh id. `proposal-superseded` means the proposal is
// settled and there is nothing to retry, and its sentence says WHY, because the three reasons are
// different facts: the routine moved after the diff was written; a newer proposal replaced this
// one (`gym_proposals.superseded_by` names it); or it was superseded before the reason was
// recorded. The code is one, so a client's branch is one.
// `proposal-settled` means the other decision was already taken; asking for the decision that was
// taken replays 200 with the stored proposal.
class ProgramApi {
public:
  ProgramApi(std::shared_ptr<ProgramService> program, std::shared_ptr<AuthService> auth);

  void listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/routines
  void createRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/gym/routines
  void getRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/routines/{id}
  void replaceRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // PUT  /v1/gym/routines/{id}
  void deleteRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // DELETE /v1/gym/routines/{id}
  // Owner-scoped, HTTP only: no MCP tool settles a proposal at any grant level.
  void listProposals(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/proposals?routineId=&state=pending
  void getProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // GET  /v1/gym/proposals/{id}
  void applyProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& id);                                  // POST /v1/gym/proposals/{id}/apply
  void dismissProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id);                                // POST /v1/gym/proposals/{id}/dismiss

private:
  std::shared_ptr<ProgramService> program_;
  std::shared_ptr<AuthService> auth_;
};

}
