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

// Every read is owner-scoped: the seed movements plus the caller's own rows, never another account's.
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
