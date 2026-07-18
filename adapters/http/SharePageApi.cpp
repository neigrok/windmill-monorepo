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

SharePageApi::SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<AuthService> auth,
                           std::string webRoot)
    : registry_(std::move(registry)), auth_(std::move(auth)), webRoot_(std::move(webRoot)) {}

std::string SharePageApi::renderShell(const std::string& shell, const std::string& title,
                                      std::size_t steps, Visibility visibility, const std::string& id) {
  static const std::string startTag = "<!-- meta:unfurl:start -->";
  static const std::string endTag = "<!-- meta:unfurl:end -->";
  const std::size_t start = shell.find(startTag);
  const std::size_t end = shell.find(endTag);
  if (start == std::string::npos || end == std::string::npos || end < start) return shell;

  const std::string safeTitle = htmlEscape(title.empty() ? "Untitled tree" : title);
  const std::string url = "https://windmill.works/t/" + htmlEscape(id);
  const std::string description =
      "A Windmill skill tree \xE2\x80\x94 " + std::to_string(steps) + (steps == 1 ? " step." : " steps.");
  const std::string robots =
      visibility == Visibility::public_ ? "index, follow, max-image-preview:large" : "noindex";
  const std::string image = "https://windmill.works/og-image.png";

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

  callback(htmlResponse(readable ? renderShell(shell, title, steps, visibility, id) : shell));
}

}
