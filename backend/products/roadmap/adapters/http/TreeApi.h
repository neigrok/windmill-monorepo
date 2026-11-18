#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/EngineReadModels.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/OwnerProgress.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <optional>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Reads go through the room, so they reflect live socket edits. Where the engine serves roadmap, `engine` is set and the
// activity and the progress read its records instead (roadmap-on-the-engine.md §7).
class TreeApi {
public:
  TreeApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
          std::shared_ptr<OwnerProgress> progress, std::shared_ptr<OpLog> ops, std::shared_ptr<AuthService> auth,
          std::shared_ptr<ForkService> fork, std::shared_ptr<EngineReadModels> engine);

  void getTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void forkTree(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getProgress(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getGuides(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getDiagnostics(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);
  void getActivity(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);

private:
  std::optional<UserId> callerOf(const drogon::HttpRequestPtr& req) const;

  // The read gate every room-backed read shares: holds the tree's strand, and answers false
  // without a reason when the caller may not have the tree.
  bool readRoom(const std::string& treeId, const std::optional<UserId>& caller,
                const std::function<void(TreeRoom&)>& read);
  // The read gate every read of the engine's records shares, as readRoom is the rooms': answers false without a reason
  // when the roadmap does not stand, the caller may not read it, or the read fails, which files one Issue under
  // `roadmap.tree.read`.
  bool readRecords(const std::string& treeId, const std::optional<UserId>& caller,
                   const std::function<void(const ReadableRoadmap&)>& read);
  // A subtree's place and name, read through its parents OUTSIDE the strand: nothing when it no longer stands, or when
  // the read fails, which is reported under its own operation (`roadmap.tree.place`).
  std::optional<Place> placeOf(const TreeId& tree);

  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<OwnerProgress> progress_;
  std::shared_ptr<OpLog> ops_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<ForkService> fork_;
  std::shared_ptr<EngineReadModels> engine_;
};

}
