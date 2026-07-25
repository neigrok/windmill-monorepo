#include "adapters/http/GalleryApi.h"

#include "adapters/http/Caller.h"
#include "adapters/http/PageShell.h"
#include "adapters/json/TreeJson.h"

#include <charconv>
#include <optional>
#include <string>
#include <system_error>
#include <utility>

namespace wm {

namespace {
drogon::HttpResponsePtr jsonResponse(const Json::Value& body) {
  return drogon::HttpResponse::newHttpJsonResponse(body);
}

drogon::HttpResponsePtr error(drogon::HttpStatusCode status, const std::string& message, const char* code) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  body["code"] = code;  // the machine-readable vocabulary: "bad-limit", "unknown-cursor"
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  return response;
}
}

GalleryApi::GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
                       std::shared_ptr<AuthService> auth, std::string webRoot)
    : trees_(std::move(trees)), progress_(std::move(progress)), auth_(std::move(auth)),
      webRoot_(std::move(webRoot)) {}

std::vector<WallCandidate> GalleryApi::candidates() {
  std::vector<ListedTree> listed = trees_->listPublic();

  // Phase two: the owner's overlay per listed tree, because a shared tree shows the OWNER's
  // journey (HttpApi::getProgress makes the same ruling). One narrow read per card — so a gallery
  // costs a query per listed tree and is rebuilt on every hit. That is nothing against a wall of
  // tens and the wrong thing to pre-optimize, but it is the number to watch: the fix when it bites
  // is to cache the ranked index for a minute, not to thin the read. The shared per-IP limiter
  // (infra/main.cpp) already bounds how fast a stranger can ask. Everything else a card needs —
  // fork count, fork lineage — rides listPublic's own row rather than adding a second such loop.
  std::vector<WallCandidate> candidates;
  candidates.reserve(listed.size());
  for (ListedTree& tree : listed) {
    WallCandidate candidate;
    candidate.ownerProgress = progress_->load(tree.data.id, tree.owner);
    candidate.owner = std::move(tree.owner);
    candidate.data = std::move(tree.data);
    candidate.updatedAt = tree.updatedAt;
    candidate.forks = tree.forks;
    candidate.sourceTitle = std::move(tree.sourceTitle);
    candidates.push_back(std::move(candidate));
  }
  return candidates;
}

std::string GalleryApi::renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall) {
  if (wall.empty()) return shell;  // the template's own empty state stands

  std::string cards;
  for (const GalleryEntry& entry : wall) {
    const std::string id = htmlEscape(entry.id.str());
    const int percent = entry.stats.total > 0 ? entry.stats.done * 100 / entry.stats.total : 0;
    // A card wears its tree's dominant kind as a bar across the top of the portrait, the same way a
    // node wears its kind in the tree — the legend is the identity everywhere it appears.
    const char* hue = nodeColorHex(entry.stats.dominantKind.value_or(NodeColor::terracotta));

    cards += "\n        <a class=\"card\" href=\"/t/" + id + "\">\n";
    // The portrait is the tree's own uploaded unfurl card; /og/:id.png falls back to the generic
    // one when a tree has none, so a card can never show a broken image.
    cards += "          <span class=\"shot\"><img src=\"/og/" + id
             + ".png\" alt=\"\" loading=\"lazy\" width=\"1200\" height=\"630\" />"
               "<i class=\"hue\" style=\"background:" + hue + "\"></i></span>\n";
    cards += "          <span class=\"body\">\n";
    cards += "            <span class=\"ct\">" + htmlEscape(entry.title) + "</span>\n";
    cards += "            <span class=\"bar\"><i style=\"width:" + std::to_string(percent) + "%\"></i></span>\n";
    cards += "            <span class=\"meta\"><span class=\"done\">" + std::to_string(entry.stats.done) + "/"
             + std::to_string(entry.stats.total) + " done</span>";
    // A fork is the one honest popularity signal the wall has — shown only when it happened, so a
    // brand-new tree reads as new rather than as unwanted.
    if (entry.forks > 0)
      cards += "<i class=\"sep\"></i><span class=\"forks\">forked " + std::to_string(entry.forks)
               + (entry.forks == 1 ? " time" : " times") + "</span>";
    // The one exception to "no author on the wall": a fork names the TREE it came from, never the
    // person who planted it — the same attribution the unfurl carries, and only for a source that
    // is still public (the repository resolves that; an unnamed source leaves this off entirely).
    // Last on the line because a card leads with what the tree is and closes with where it came from.
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
  // The wall knows nobody — a default Viewer — so no row wears a caller-relative mark, and the
  // page is the same bytes for everyone. It shows the index's first page, and with no cursor to
  // refuse that page always resolves.
  const std::vector<GalleryEntry> wall = publicWall(candidates(), Viewer{});
  const std::vector<GalleryEntry> firstPage = wallPage(wall, "", kWallLimit)->entries;

  // A misconfigured web root degrades to a bare document carrying the same markers rather than
  // to nothing: the links ARE the page's reason to exist, and they still work unstyled.
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
    // Trailing junk is a refusal, not a prefix to read: "12cards" is a caller who thinks they
    // asked for something we didn't give them.
    if (parsed.ec != std::errc{} || parsed.ptr != last || value < 1 || value > static_cast<int>(kWallLimit)) {
      callback(error(drogon::k400BadRequest,
                     "limit must be a number between 1 and " + std::to_string(kWallLimit) + "; got "
                         + requestedLimit,
                     "bad-limit"));
      return;
    }
    limit = static_cast<std::size_t>(value);
  }

  // Anonymous is a first-class caller here: the shelf is the wall with two extra facts on each
  // row, so a signed-out reader gets the wall's rows exactly, and nothing is gated on the session.
  const std::optional<UserId> caller = callerOf(req, *auth_);
  Viewer viewer;
  if (caller) {
    viewer.user = caller;
    viewer.forked = trees_->listForkedSources(*caller);  // one read for the whole page, never per card
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
