#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/ports/ProgramRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The routines and the proposal ledger, read. Owner-scoped: absent and another account's are one 404.
class ProgramApi {
public:
  ProgramApi(std::shared_ptr<ProgramRepository> program, std::shared_ptr<AuthService> auth);

  void listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // GET  /v1/gym/routines
  void getRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                  const std::string& id);                                     // GET  /v1/gym/routines/{id}
  void listProposals(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/proposals?routineId=&state=pending
  void getProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                   const std::string& id);                                    // GET  /v1/gym/proposals/{id}

private:
  std::shared_ptr<ProgramRepository> program_;
  std::shared_ptr<AuthService> auth_;
};

}
