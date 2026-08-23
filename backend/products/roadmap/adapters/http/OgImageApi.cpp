#include "products/roadmap/adapters/http/OgImageApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/domain/Access.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace wm {

namespace {
constexpr std::size_t kMaxImageBytes = 3 * 1024 * 1024;

drogon::HttpResponsePtr genericCard() {
  return drogon::HttpResponse::newRedirectionResponse("/og-image.png", drogon::k302Found);
}
}

OgImageApi::OgImageApi(std::shared_ptr<OgImageRepository> images, std::shared_ptr<TreeRepository> trees,
                       std::shared_ptr<AuthService> auth)
    : images_(std::move(images)), trees_(std::move(trees)), auth_(std::move(auth)) {}

void OgImageApi::putImage(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id) {
  const std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to update the share image"));
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
  // Anyone may request an unfurl card: read the two access columns, never the whole lattice.
  const std::optional<UserId> caller = callerOf(req, *auth_);
  const std::optional<TreeAccess> tree = trees_->loadAccess(TreeId{id});
  if (!tree || !canRead(caller, tree->owner, tree->visibility)) {
    callback(genericCard());  // absent and private-denied are indistinguishable from having no card
    return;
  }
  const std::optional<std::string> png = images_->get(id);
  if (!png) {
    callback(genericCard());
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_IMAGE_PNG);
  response->addHeader("Cache-Control", "public, max-age=300");
  response->setBody(std::move(*png));
  callback(response);
}

}
