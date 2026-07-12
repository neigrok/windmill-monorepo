#pragma once

#include "application/RoomRegistry.h"
#include "domain/Ids.h"
#include "ports/OpLog.h"
#include "ports/ProgressRepository.h"
#include "ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Phase 0 REST surface. Reads go through the room (so they reflect live socket edits);
// PUT is the whole-document fallback, which evicts the room so the next open reloads it.
class HttpApi {
public:
  HttpApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
          std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis, UserId caller);

  void getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);

private:
  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::shared_ptr<OpLog> ops_;
  Hlc genesis_;
  UserId caller_;
};

}
