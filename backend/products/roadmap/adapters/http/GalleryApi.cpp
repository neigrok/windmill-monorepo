#include "products/roadmap/adapters/http/GalleryApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/PageShell.h"
#include "products/roadmap/adapters/json/TreeJson.h"

#include <trantor/utils/Logger.h>

#include <charconv>
#include <map>
#include <optional>
#include <string>
#include <system_error>
#include <utility>

namespace wm {

GalleryApi::GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<OwnerProgress> progress,
                       std::shared_ptr<AuthService> auth, std::string webRoot)
    : trees_(std::move(trees)), progress_(std::move(progress)), auth_(std::move(auth)),
      webRoot_(std::move(webRoot)) {}

std::vector<WallCandidate> GalleryApi::candidates() {
  std::vector<ListedTree> listed = trees_->listPublic();
  std::vector<WallCandidate> candidates;
  candidates.reserve(listed.size());
  for (ListedTree& tree : listed) {
    WallCandidate candidate;
    candidate.owner = tree.owner;
    candidate.data = std::move(tree.data);
    candidate.updatedAt = tree.updatedAt;
    candidate.forks = tree.forks;
    candidate.sourceTitle = std::move(tree.sourceTitle);
    candidates.push_back(std::move(candidate));
  }

  // A shared tree shows the OWNER's journey, so each card carries the owner's marks as a reader is shown them. Owners
  // are followed in the order the wall shows their cards as far as it is known before their marks are: by forks, then
  // by the tree's own last edit, so no account comes first by the id it holds. A tree off the wall is followed for no one.
  std::map<TreeId, std::size_t> at;
  for (std::size_t i = 0; i < candidates.size(); ++i) at.emplace(candidates[i].data.id, i);
  std::vector<OwnersTrees> owners;
  std::map<UserId, std::size_t> ownerAt;
  for (const GalleryEntry& entry : publicWall(candidates, Viewer{})) {
    const std::size_t i = at.at(entry.id);
    const auto [slot, fresh] = ownerAt.emplace(candidates[i].owner, owners.size());
    if (fresh) owners.push_back(OwnersTrees{candidates[i].owner, {}});
    owners[slot->second].trees.emplace(entry.id, std::move(listed[i].pointers));
  }
  ShownToReaders shown = progress_->shownToReaders(owners, kFollowCap, "gallery");
  if (shown.tally.degraded())
    LOG_INFO << "roadmap_gallery_follows followed=" << shown.tally.followed << " timed_out=" << shown.tally.timedOut
             << " failed=" << shown.tally.failed << " cooling_off=" << shown.tally.coolingOff
             << " past_cap=" << shown.tally.pastCap;

  for (WallCandidate& candidate : candidates) {
    const auto marks = shown.progress.find(candidate.data.id);
    if (marks != shown.progress.end()) candidate.ownerProgress = std::move(marks->second);
  }
  return candidates;
}

std::string GalleryApi::renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall) {
  if (wall.empty()) return shell;

  std::string cards;
  for (const GalleryEntry& entry : wall) {
    const std::string id = htmlEscape(entry.id.str());
    const int percent = entry.stats.total > 0 ? entry.stats.done * 100 / entry.stats.total : 0;
    const char* hue = nodeColorHex(entry.stats.dominantKind.value_or(NodeColor::terracotta));

    cards += "\n        <a class=\"card\" href=\"/t/" + id + "\">\n";
    cards += "          <span class=\"shot\"><img src=\"/og/" + id
             + ".png\" alt=\"\" loading=\"lazy\" width=\"1200\" height=\"630\" />"
               "<i class=\"hue\" style=\"background:" + hue + "\"></i></span>\n";
    cards += "          <span class=\"body\">\n";
    cards += "            <span class=\"ct\">" + htmlEscape(entry.title) + "</span>\n";
    cards += "            <span class=\"bar\"><i style=\"width:" + std::to_string(percent) + "%\"></i></span>\n";
    cards += "            <span class=\"meta\"><span class=\"done\">" + std::to_string(entry.stats.done) + "/"
             + std::to_string(entry.stats.total) + " done</span>";
    if (entry.forks > 0)
      cards += "<i class=\"sep\"></i><span class=\"forks\">forked " + std::to_string(entry.forks)
               + (entry.forks == 1 ? " time" : " times") + "</span>";
    if (!entry.sourceTitle.empty())
      cards += "<i class=\"sep\"></i><span class=\"from\">A fork of \xE2\x80\x9C"
               + htmlEscape(entry.sourceTitle) + "\xE2\x80\x9D</span>";
    cards += "</span>\n";
    cards += "          </span>\n";
    cards += "        </a>";
  }
  cards += "\n      ";

  return spliceBetween(shell, "<!-- wall:cards:start -->", "<!-- wall:cards:end -->", cards);
}

void GalleryApi::page(const drogon::HttpRequestPtr&, HttpCallback&& callback) {
  const std::vector<GalleryEntry> wall = publicWall(candidates(), Viewer{});
  const std::vector<GalleryEntry> firstPage = wallPage(wall, "", kWallLimit)->entries;

  std::string shell = readWebFile(webRoot_, "gallery.html");
  if (shell.empty())
    shell =
        "<!doctype html><meta charset=\"utf-8\"><title>Gallery \xE2\x80\x94 Windmill</title>"
        "<!-- wall:cards:start --><!-- wall:cards:end -->";
  callback(htmlPage(renderWall(shell, firstPage)));
}

void GalleryApi::index(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  const std::string requestedLimit = req->getParameter("limit");
  std::size_t limit = kWallLimit;
  if (!requestedLimit.empty()) {
    int value = 0;
    const char* last = requestedLimit.data() + requestedLimit.size();
    const std::from_chars_result parsed = std::from_chars(requestedLimit.data(), last, value);
    // Trailing junk is a refusal, not a prefix to read.
    if (parsed.ec != std::errc{} || parsed.ptr != last || value < 1 || value > static_cast<int>(kWallLimit)) {
      callback(error(drogon::k400BadRequest,
                     "limit must be a number between 1 and " + std::to_string(kWallLimit) + "; got "
                         + requestedLimit,
                     "bad-limit"));
      return;
    }
    limit = static_cast<std::size_t>(value);
  }

  const std::optional<UserId> caller = callerOf(req, *auth_);
  Viewer viewer;
  if (caller) {
    viewer.user = caller;
    viewer.forked = trees_->listForkedSources(*caller);
  }

  const std::vector<GalleryEntry> wall = publicWall(candidates(), viewer);
  const std::string cursor = req->getParameter("cursor");
  const std::optional<WallPage> page = wallPage(wall, cursor, limit);
  if (!page) {
    callback(error(drogon::k400BadRequest,
                   "unknown cursor: " + cursor
                       + " — it names no tree in this gallery; ask again without a cursor to walk "
                         "it from the start",
                   "unknown-cursor"));
    return;
  }

  Json::Value entries(Json::arrayValue);
  for (const GalleryEntry& entry : page->entries) entries.append(toJson(entry));
  Json::Value body(Json::objectValue);
  body["entries"] = entries;
  body["count"] = static_cast<Json::UInt64>(wall.size());  // the whole index, not this page
  if (!page->nextCursor.empty()) body["nextCursor"] = page->nextCursor;
  callback(jsonResponse(body));
}

}
