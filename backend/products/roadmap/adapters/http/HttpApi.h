#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <optional>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The REST surface. Reads go through the room, so they reflect live socket edits; PUT is the
// whole-document fallback, which evicts the room so the next open reloads it.
class HttpApi {
public:
  HttpApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
          std::shared_ptr<ProgressRepository> progress, std::shared_ptr<OpLog> ops, Hlc genesis,
          std::shared_ptr<AuthService> auth, std::shared_ptr<ForkService> fork);

  void getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void putTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);

private:
  // The authenticated caller, resolved from the wm_session cookie or a Bearer token; empty
  // for an anonymous request (which may read public trees but never write).
  std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req) const;

  // The read gate every room-backed read shares: hold the tree's strand, open the room, and run
  // `read` against it, answering false and never a reason when the caller may not have it.
  bool readRoom(const std::string& treeId, const std::optional<UserId>& caller,
                const std::function<void(TreeRoom&)>& read);

  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::shared_ptr<OpLog> ops_;
  Hlc genesis_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<ForkService> fork_;
};

}
