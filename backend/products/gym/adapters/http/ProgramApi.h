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

// The program over REST — routines, and the proposal ledger an agent writes into and only a hand
// settles. One of five HTTP adapters mirroring the five aggregate ports (TrainingApi holds the
// status ladder they all share; routes.cpp is the one mount).
//
// Three codes are this file's. `routine-id-taken` is repaired by minting a fresh id.
// `proposal-superseded` means the routine moved after the diff was computed, so the card is settled
// and there is nothing to retry. `proposal-settled` means the other decision was already taken and
// the screen has gone stale. Asking for the decision that WAS taken is not a refusal: it replays 200
// with the stored proposal.
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
  // The proposal ledger's four owner-scoped doors. The last two are the only writers of `applied`
  // and `dismissed` anywhere in this product, and no MCP tool reaches them at any grant level
  // (routes.cpp says so beside the mounts; GymToolsTest pins the absence).
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
