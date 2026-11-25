#include "products/roadmap/adapters/http/OgVideoApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/PageShell.h"
#include "products/roadmap/domain/Access.h"

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

OgVideoApi::OgVideoApi(std::shared_ptr<OgVideoRepository> videos, std::shared_ptr<RoomRegistry> rooms,
                       std::shared_ptr<AuthService> auth, std::shared_ptr<EngineReadModels> engine)
    : videos_(std::move(videos)), rooms_(std::move(rooms)), auth_(std::move(auth)), engine_(std::move(engine)) {}

void OgVideoApi::putVideo(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::optional<UserId> caller = SentCaller::of(req, *auth_).account();
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to update the share video"));
    return;
  }
  // The access gate every door shares: an absent tree, one the caller may not read and a hidden branch's answer alike.
  const std::optional<TreeAccess> tree = engine_ ? engine_->access(TreeId{id}, caller) : rooms_->accessOf(TreeId{id});
  if (!tree || !canRead(caller, tree->owner, tree->visibility)) {
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
  // Anyone may request a share video: ask the access gate, never the whole lattice. A video shows an anonymous caller
  // public content alone, so credentials that serve no account read as anonymous.
  const std::optional<UserId> caller = SentCaller::of(req, *auth_).account();
  const std::optional<TreeAccess> tree = engine_ ? engine_->access(TreeId{id}, caller) : rooms_->accessOf(TreeId{id});
  // No video, which no cache keeps when the answer is the caller's alone.
  const auto noVideo = [&callback](Audience audience) {
    auto response = error(drogon::k404NotFound, "no such video");
    if (audience == Audience::caller) response->addHeader("Cache-Control", cacheControlFor(audience));
    callback(response);
  };
  if (!tree || !canRead(caller, tree->owner, tree->visibility)) return noVideo(Audience::caller);
  // Only the video of a tree anyone with its address may read is the same for everyone; its owner's private one is theirs.
  const Audience audience = canRead(std::nullopt, tree->owner, tree->visibility) ? Audience::everyone : Audience::caller;
  const std::optional<StoredVideo> video = videos_->get(id);
  if (!video) return noVideo(audience);
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeString(video->mime);
  response->addHeader("Cache-Control", cacheControlFor(audience));
  response->setBody(std::move(video->bytes));
  callback(response);
}

}
