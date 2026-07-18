#pragma once

#include "application/AuthService.h"
#include "application/RoomRegistry.h"
#include "domain/Access.h"
#include "domain/Ids.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Serves the SPA shell at the real path GET /t/:id, so a shared tree's link unfurls as itself
// for social scrapers. For an anon-readable tree it rewrites the fenced unfurl meta in the
// shell (title, description, canonical, og:*, twitter:*) with the tree's own; a private or
// absent tree gets the shell byte-for-byte verbatim — indistinguishable, preserving the
// "private = absent" invariant. Either way the SPA boots and fetches /v1/trees/:id in-page.
class SharePageApi {
public:
  SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<AuthService> auth,
               std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);

  // The pure templating boundary (tested directly): splice this tree's unfurl meta between
  // the index.html sentinels, keeping the sentinels. Returns the shell unchanged if the
  // fence is absent. `title` is escaped here; `steps` is the node count; `visibility`
  // decides robots (public indexes, unlisted is noindex); `id` fills the canonical + og:url.
  static std::string renderShell(const std::string& shell, const std::string& title,
                                 std::size_t steps, Visibility visibility, const std::string& id);

private:
  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<AuthService> auth_;
  std::string webRoot_;
};

}
