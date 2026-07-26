#include "products/roadmap/adapters/http/OgVideoApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/domain/Access.h"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace wm {

namespace {
constexpr std::size_t kMaxVideoBytes = 3 * 1024 * 1024;  // 3 MB — a short 1080×1080 loop encodes well under this

// The container the upload leads with, by magic bytes: an ISO-BMFF (mp4) box tags bytes 4..8
// "ftyp"; a Matroska/WebM stream opens with the EBML header 1A 45 DF A3. Anything else is refused,
// so the store only ever holds a real video the og:video tag can point a scraper at.
std::optional<std::string> detectMime(std::string_view body) {
  if (body.size() >= 8 && body.substr(4, 4) == std::string_view{"ftyp"}) return "video/mp4";
  static constexpr char ebml[] = {'\x1a', '\x45', '\xdf', '\xa3'};
  if (body.size() >= 4 && body.substr(0, 4) == std::string_view{ebml, 4}) return "video/webm";
  return std::nullopt;
}
}

OgVideoApi::OgVideoApi(std::shared_ptr<OgVideoRepository> videos, std::shared_ptr<TreeRepository> trees,
                       std::shared_ptr<AuthService> auth)
    : videos_(std::move(videos)), trees_(std::move(trees)), auth_(std::move(auth)) {}

void OgVideoApi::putVideo(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to update the share video"));
    return;
  }
  const std::optional<StoredTree> tree = trees_->load(TreeId{id});
  if (!tree) {
    callback(error(drogon::k404NotFound, "no such tree"));
    return;
  }
  if (!tree->owner || *tree->owner != *caller) {
    callback(error(drogon::k403Forbidden, "this tree belongs to another account"));
    return;
  }

  const std::string_view body = req->getBody();
  if (body.size() > kMaxVideoBytes) {
    callback(error(drogon::k413RequestEntityTooLarge, "video too large (max 3 MB)"));
    return;
  }
  const std::optional<std::string> mime = detectMime(body);
  if (!mime) {
    callback(error(drogon::k400BadRequest, "body must be an mp4 or webm video"));
    return;
  }

  videos_->put(id, std::string(body), *mime);
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

void OgVideoApi::getVideo(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  // Anyone may request a tree's share video, so this stays a cheap read: the two access columns,
  // not the whole lattice. Unlike the og:image card there is no generic fallback — the og:image
  // poster is the fallback — so absence, an unreadable tree, or a private-denied one is a plain 404.
  const std::optional<UserId> caller = callerOf(req, *auth_);
  const std::optional<TreeAccess> tree = trees_->loadAccess(TreeId{id});
  if (!tree || !canRead(caller, tree->owner, tree->visibility)) {
    callback(error(drogon::k404NotFound, "no such video"));
    return;
  }
  const std::optional<StoredVideo> video = videos_->get(id);
  if (!video) {
    callback(error(drogon::k404NotFound, "no such video"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeString(video->mime);  // drogon has no video enum — echo the stored mime verbatim
  response->addHeader("Cache-Control", "public, max-age=300");
  response->setBody(std::move(video->bytes));
  callback(response);
}

}
