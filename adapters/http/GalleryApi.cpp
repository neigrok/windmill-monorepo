#include "adapters/http/GalleryApi.h"

#include "adapters/http/PageShell.h"

#include <string>
#include <utility>

namespace wm {

GalleryApi::GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
                       std::string webRoot)
    : trees_(std::move(trees)), progress_(std::move(progress)), webRoot_(std::move(webRoot)) {}

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
    cards += "</span>\n";
    cards += "          </span>\n";
    cards += "        </a>";
  }
  cards += "\n      ";

  return spliceBetween(shell, "<!-- wall:cards:start -->", "<!-- wall:cards:end -->", cards);
}

void GalleryApi::page(const drogon::HttpRequestPtr&, HttpCallback&& callback) {
  std::vector<ListedTree> listed = trees_->listPublic();

  // Phase two: the owner's overlay per listed tree, because a shared tree shows the OWNER's
  // journey (HttpApi::getProgress makes the same ruling). One narrow read per card — so the page
  // costs a query per listed tree and rebuilds on every hit. That is nothing against a wall of
  // tens and the wrong thing to pre-optimize, but it is the number to watch: the fix when it
  // bites is to cache the rendered wall for a minute, not to thin the read. The shared per-IP
  // limiter (infra/main.cpp) already bounds how fast a stranger can ask.
  std::vector<WallCandidate> candidates;
  candidates.reserve(listed.size());
  for (ListedTree& tree : listed) {
    WallCandidate candidate;
    candidate.ownerProgress = progress_->load(tree.data.id, tree.owner);
    candidate.data = std::move(tree.data);
    candidate.updatedAt = tree.updatedAt;
    candidate.forks = tree.forks;
    candidates.push_back(std::move(candidate));
  }

  const std::vector<GalleryEntry> wall = publicWall(candidates, kWallLimit);
  // A misconfigured web root degrades to a bare document carrying the same markers rather than
  // to nothing: the links ARE the page's reason to exist, and they still work unstyled.
  std::string shell = readWebFile(webRoot_, "gallery.html");
  if (shell.empty())
    shell =
        "<!doctype html><meta charset=\"utf-8\"><title>Gallery \xE2\x80\x94 Windmill</title>"
        "<!-- wall:cards:start --><!-- wall:cards:end -->";
  callback(htmlPage(renderWall(shell, wall)));
}

}
