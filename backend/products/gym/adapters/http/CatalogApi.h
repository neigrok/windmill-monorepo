#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/TrainingService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The catalog of movements over REST — the seeds plus this lifter's own, and a movement's record.
// One of five HTTP adapters mirroring the five aggregate ports (TrainingApi holds the status ladder
// they all share; routes.cpp is the one mount). It holds TWO services: a movement's record is a read
// of the LOG, so `exerciseRecord` goes through TrainingService.
//
// Every read is owner-scoped — the seeds plus the caller's own rows and never another account's —
// and the one code this file mints is `exercise-id-taken`, repaired by minting a fresh id.
// `GET /v1/gym/exercises/last` is a read of the LOG and lives on TrainingApi even though it hangs
// off the catalog's path.
class CatalogApi {
public:
  CatalogApi(std::shared_ptr<CatalogService> catalog, std::shared_ptr<TrainingService> training,
             std::shared_ptr<AuthService> auth);

  void listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/exercises
  void createExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/exercises
  void renameExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // PATCH /v1/gym/exercises/{id}
  void exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& id);                                 // GET  /v1/gym/exercises/{id}/record

private:
  std::shared_ptr<CatalogService> catalog_;
  std::shared_ptr<TrainingService> training_;
  std::shared_ptr<AuthService> auth_;
};

}
