#include "adapters/http/SharePageApi.h"

#include "adapters/http/Caller.h"
#include "application/TreeRoom.h"
#include "domain/Tree.h"

#include <exception>
#include <fstream>
#include <mutex>
#include <optional>
#include <sstream>

namespace wm {

namespace {
std::string htmlEscape(const std::string& text) {
  std::string out;
  out.reserve(text.size());
  for (char c : text) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += c;
    }
  }
  return out;
}

std::string readShell(const std::string& webRoot) {
  if (webRoot.empty()) return {};
  std::ifstream file(webRoot + "/index.html", std::ios::binary);
  if (!file) return {};
  std::ostringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

drogon::HttpResponsePtr htmlResponse(std::string body) {
  auto resp = drogon::HttpResponse::newHttpResponse();
  resp->setStatusCode(drogon::k200OK);
  resp->setContentTypeCode(drogon::CT_TEXT_HTML);
  resp->addHeader("Cache-Control", "public, max-age=300");
  resp->setBody(std::move(body));
  return resp;
}
}

SharePageApi::SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
                           std::shared_ptr<AuthService> auth, std::shared_ptr<OgVideoRepository> videos,
                           std::string webRoot)
    : registry_(std::move(registry)), trees_(std::move(trees)), auth_(std::move(auth)),
      videos_(std::move(videos)), webRoot_(std::move(webRoot)) {}

std::string SharePageApi::renderShell(const std::string& shell, const std::string& title,
                                      std::size_t steps, Visibility visibility, const std::string& id,
                                      const ForkLineage& lineage, bool hasVideo) {
  static const std::string startTag = "<!-- meta:unfurl:start -->";
  static const std::string endTag = "<!-- meta:unfurl:end -->";
  const std::size_t start = shell.find(startTag);
  const std::size_t end = shell.find(endTag);
  if (start == std::string::npos || end == std::string::npos || end < start) return shell;

  const std::string safeTitle = htmlEscape(title.empty() ? "Untitled tree" : title);
  const std::string host = "https://windmill.works";
  const std::string url = host + "/t/" + htmlEscape(id);
  // Fork attribution (fork-attribution-unfurl): the description advertises the loop this tree came
  // from and the loop it invites. The source is named only when loadForkLineage found it public;
  // an unlisted/private source stays anonymous ("a forked Windmill skill tree").
  const std::string stepPhrase = std::to_string(steps) + (steps == 1 ? " step." : " steps.");
  std::string description;
  if (lineage.isFork && !lineage.sourceTitle.empty())
    description = "A fork of \xE2\x80\x9C" + htmlEscape(lineage.sourceTitle) + "\xE2\x80\x9D \xE2\x80\x94 " + stepPhrase;
  else if (lineage.isFork)
    description = "A forked Windmill skill tree \xE2\x80\x94 " + stepPhrase;
  else
    description = "A Windmill skill tree \xE2\x80\x94 " + stepPhrase;
  if (lineage.forkCount > 0)
    description += " Forked " + std::to_string(lineage.forkCount) + (lineage.forkCount == 1 ? " time." : " times.");
  const std::string robots =
      visibility == Visibility::public_ ? "index, follow, max-image-preview:large" : "noindex";
  // Per-tree unfurl card (og-tree-cards): GET /og/:id.png serves this tree's own rendered image
  // and falls back to the generic card when none was uploaded — so the tag can always point here.
  const std::string image = host + "/og/" + htmlEscape(id) + ".png";

  std::string meta;
  meta += "\n\n    <!-- Rewritten for this shared tree by windmill_server (path-share). -->\n";
  meta += "    <title>" + safeTitle + " \xE2\x80\x94 Windmill</title>\n";
  meta += "    <meta name=\"description\" content=\"" + description + "\" />\n\n";
  meta += "    <link rel=\"canonical\" href=\"" + url + "\" />\n";
  meta += "    <meta name=\"robots\" content=\"" + robots + "\" />\n\n";
  meta += "    <meta property=\"og:type\" content=\"website\" />\n";
  meta += "    <meta property=\"og:site_name\" content=\"Windmill\" />\n";
  meta += "    <meta property=\"og:title\" content=\"" + safeTitle + "\" />\n";
  meta += "    <meta property=\"og:description\" content=\"" + description + "\" />\n";
  meta += "    <meta property=\"og:url\" content=\"" + url + "\" />\n";
  meta += "    <meta property=\"og:image\" content=\"" + image + "\" />\n";
  meta += "    <meta property=\"og:image:type\" content=\"image/png\" />\n";
  meta += "    <meta property=\"og:image:width\" content=\"1200\" />\n";
  meta += "    <meta property=\"og:image:height\" content=\"630\" />\n";
  // Per-tree share video (og-share-video): only for a tree that carries an uploaded loop. The
  // og:image above stays the unconditional poster fallback for scrapers that ignore og:video.
  if (hasVideo) {
    const std::string video = host + "/v1/trees/" + htmlEscape(id) + "/og-video";
    meta += "    <meta property=\"og:video\" content=\"" + video + "\" />\n";
    meta += "    <meta property=\"og:video:secure_url\" content=\"" + video + "\" />\n";
    meta += "    <meta property=\"og:video:type\" content=\"video/mp4\" />\n";
    meta += "    <meta property=\"og:video:width\" content=\"1080\" />\n";
    meta += "    <meta property=\"og:video:height\" content=\"1080\" />\n";
  }
  meta += "    <meta property=\"og:locale\" content=\"en_US\" />\n\n";
  meta += "    <meta name=\"twitter:card\" content=\"summary_large_image\" />\n";
  meta += "    <meta name=\"twitter:title\" content=\"" + safeTitle + "\" />\n";
  meta += "    <meta name=\"twitter:description\" content=\"" + description + "\" />\n";
  meta += "    <meta name=\"twitter:image\" content=\"" + image + "\" />\n    ";

  return shell.substr(0, start + startTag.size()) + meta + shell.substr(end);
}

void SharePageApi::page(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::string shell = readShell(webRoot_);
  if (shell.empty()) {
    // The web root is misconfigured (no shell to serve). Bounce the human to the working
    // hash route so the tree still opens; scrapers get nothing to unfurl, which is fine for
    // a deploy-error fallback. The target is the id the caller already holds — no leak.
    callback(htmlResponse("<!doctype html><meta http-equiv=\"refresh\" content=\"0;url=/#/t/"
                          + htmlEscape(id) + "\">"));
    return;
  }

  const std::optional<UserId> caller = callerOf(req, *auth_);
  bool readable = false;
  std::string title;
  std::size_t steps = 0;
  Visibility visibility = Visibility::private_;
  {
    std::lock_guard<std::mutex> lock(registry_->strandFor(TreeId{id}));
    try {
      TreeRoom& room = registry_->open(TreeId{id});
      if (canRead(caller, room.owner(), room.visibility())) {
        readable = true;
        title = room.title().value;
        steps = room.snapshot().nodes.size();
        visibility = room.visibility();
      }
    } catch (const std::exception&) {
      // Absent tree — leave it unreadable, so the shell is served verbatim (== private).
    }
  }

  // Fork lineage is a two-count DB read, taken OUTSIDE the room strand (never hold a room lock
  // across Postgres) and only when the tree is actually readable — a private/absent tree gets the
  // shell verbatim, so the extra query never fires for it and "private = absent" holds.
  const ForkLineage lineage = readable ? trees_->loadForkLineage(TreeId{id}) : ForkLineage{};
  // A cheap SELECT 1 (never the bytes) that decides whether the og:video tag is emitted — taken
  // only for a readable tree, so a private/absent tree never fires it and "private = absent" holds.
  const bool hasVideo = readable && videos_->has(id);
  callback(htmlResponse(readable ? renderShell(shell, title, steps, visibility, id, lineage, hasVideo) : shell));
}

}
