#pragma once

#include "domain/Ids.h"
#include "ports/ProgressRepository.h"
#include "ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Phase 0 REST surface: read/write a tree document and read its progress and
// diagnostics, straight over the repositories (no rooms yet — that is Phase 2).
class HttpApi {
public:
  HttpApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
          Hlc genesis, UserId caller);

  void getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);

private:
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  Hlc genesis_;
  UserId caller_;
};

}
