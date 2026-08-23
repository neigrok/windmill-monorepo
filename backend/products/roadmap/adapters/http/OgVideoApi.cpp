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
constexpr std::size_t kMaxVideoBytes = 3 * 1024 * 1024;

// mp4 leads with an ISO-BMFF box tagging bytes 4..8 "ftyp"; webm opens with the EBML header.
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
  if (std::optional<WriteRefusal> refusal = writeRefusalFor(caller, tree->owner)) {
    callback(error(drogon::k403Forbidden, sentenceOf(*refusal), codeOf(*refusal)));
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
  // Anyone may request a share video: read the two access columns, never the whole lattice.
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
  response->setContentTypeString(video->mime);
  response->addHeader("Cache-Control", "public, max-age=300");
  response->setBody(std::move(video->bytes));
  callback(response);
}

}
