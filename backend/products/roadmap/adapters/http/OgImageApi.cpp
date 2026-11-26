#include "products/roadmap/adapters/http/OgImageApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/PageShell.h"
#include "products/roadmap/domain/Access.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace wm {

namespace {
constexpr std::size_t kMaxImageBytes = 3 * 1024 * 1024;

// The generic card, which no cache keeps when the answer is the caller's alone.
drogon::HttpResponsePtr genericCard(Audience audience) {
  auto response = drogon::HttpResponse::newRedirectionResponse("/og-image.png", drogon::k302Found);
  if (audience == Audience::caller) response->addHeader("Cache-Control", cacheControlFor(audience));
  return response;
}
}

OgImageApi::OgImageApi(std::shared_ptr<OgImageRepository> images, std::shared_ptr<RoomRegistry> rooms,
                       std::shared_ptr<AuthService> auth, std::shared_ptr<EngineReadModels> engine)
    : images_(std::move(images)), rooms_(std::move(rooms)), auth_(std::move(auth)), engine_(std::move(engine)) {}

void OgImageApi::putImage(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::optional<UserId> caller = SentCaller::of(req, *auth_).account();
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to update the share image"));
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
  if (body.size() > kMaxImageBytes) {
    callback(error(drogon::k413RequestEntityTooLarge, "image too large (max 3 MB)"));
    return;
  }
  static constexpr char pngMagic[] = {'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'};
  const std::string_view magic{pngMagic, sizeof(pngMagic)};
  if (body.size() < magic.size() || body.substr(0, magic.size()) != magic) {
    callback(error(drogon::k400BadRequest, "body must be a PNG"));
    return;
  }

  images_->put(id, std::string(body));
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  callback(response);
}

void OgImageApi::getImage(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  // Anyone may request an unfurl card: ask the access gate, never the whole lattice. A card shows an anonymous caller
  // public content alone, so credentials that serve no account read as anonymous.
  const std::optional<UserId> caller = SentCaller::of(req, *auth_).account();
  const std::optional<TreeAccess> tree = engine_ ? engine_->access(TreeId{id}, caller) : rooms_->accessOf(TreeId{id});
  if (!tree || !canRead(caller, tree->owner, tree->visibility)) {
    callback(genericCard(Audience::caller));  // absent and private-denied are indistinguishable from having no card
    return;
  }
  // Only the card of a tree anyone with its address may read is the same for everyone; its owner's private card is theirs.
  const Audience audience = canRead(std::nullopt, tree->owner, tree->visibility) ? Audience::everyone : Audience::caller;
  const std::optional<std::string> png = images_->get(id);
  if (!png) {
    callback(genericCard(audience));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_IMAGE_PNG);
  response->addHeader("Cache-Control", cacheControlFor(audience));
  response->setBody(std::move(*png));
  callback(response);
}

}
