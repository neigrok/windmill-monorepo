#include "products/roadmap/adapters/http/OgImageApi.h"

#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <map>
#include <memory>
#include <optional>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

struct FakeOgImageRepository : OgImageRepository {
  std::map<std::string, std::string> byId;
  void put(const std::string& treeId, const std::string& pngBytes) override { byId[treeId] = pngBytes; }
  std::optional<std::string> get(const std::string& treeId) override {
    auto it = byId.find(treeId);
    if (it == byId.end()) return std::nullopt;
    return it->second;
  }
};

// The 8-byte PNG signature every real upload leads with, plus a little payload.
const std::string PNG = std::string("\x89PNG\r\n\x1a\n", 8) + "fake-card-bytes";

struct Harness {
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>();
  std::shared_ptr<FakeOgImageRepository> images = std::make_shared<FakeOgImageRepository>();
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");

  OgImageApi make() { return OgImageApi{images, trees, auth}; }

  UserId signIn(const std::string& sessionSecret, const std::string& emailAddr = "sam@example.com") {
    User user = authRepo.createUser(Email{emailAddr}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void seed(const char* id, const std::optional<UserId>& owner, Visibility visibility) {
    trees->byId[id] = StoredTree{GraphState{}, LegendState{}, {"Tree", {}}, 0, owner, visibility};
  }
};

drogon::HttpRequestPtr putReq(const std::string& session, const std::string& body) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Put);
  if (!session.empty()) req->addCookie("wm_session", session);
  req->setContentTypeCode(drogon::CT_IMAGE_PNG);
  req->setBody(body);
  return req;
}

drogon::HttpRequestPtr getReq(const std::string& session) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr sendPut(OgImageApi& api, const std::string& session, const std::string& id,
                                const std::string& body) {
  drogon::HttpResponsePtr captured;
  api.putImage(putReq(session, body), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGet(OgImageApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getImage(getReq(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

}

// ---- PUT /v1/trees/:id/og-image : owner-only upload --------------------------------------

TEST(put_stores_the_card_for_the_owner_and_answers_204) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_mine", PNG);

  CHECK_EQ(resp->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.images->byId.count("t_mine"), std::size_t{1});
  CHECK_EQ(h.images->byId["t_mine"], PNG);
}

TEST(put_by_an_anonymous_caller_is_401_and_stores_nothing) {
  Harness h;
  h.seed("t_mine", UserId{"owner"}, Visibility::unlisted);
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "", "t_mine", PNG);

  CHECK_EQ(resp->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(h.images->byId.count("t_mine"), std::size_t{0});
}

TEST(put_by_a_signed_in_non_owner_is_403_and_stores_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_mine", UserId{"owner"}, Visibility::unlisted);
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-other", "t_mine", PNG);

  CHECK_EQ(resp->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(h.images->byId.count("t_mine"), std::size_t{0});
}

TEST(put_to_an_unclaimed_tree_is_403) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_orphan", std::nullopt, Visibility::public_);  // no owner — nobody equals it
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_orphan", PNG);

  CHECK_EQ(resp->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(h.images->byId.count("t_orphan"), std::size_t{0});
}

TEST(put_to_an_absent_tree_is_404) {
  Harness h;
  h.signIn("s-me");
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_ghost", PNG);

  CHECK_EQ(resp->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(h.images->byId.count("t_ghost"), std::size_t{0});
}

TEST(put_over_the_3mb_cap_is_413_even_with_a_valid_signature) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgImageApi api = h.make();
  std::string tooBig = std::string("\x89PNG\r\n\x1a\n", 8) + std::string(3 * 1024 * 1024, 'x');

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_mine", tooBig);

  CHECK_EQ(resp->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(h.images->byId.count("t_mine"), std::size_t{0});
}

TEST(put_of_a_non_png_body_is_400) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgImageApi api = h.make();

  drogon::HttpResponsePtr shortBody = sendPut(api, "s-me", "t_mine", "abc");
  drogon::HttpResponsePtr wrongMagic = sendPut(api, "s-me", "t_mine", "not-a-png-at-all!!");

  CHECK_EQ(shortBody->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(wrongMagic->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(h.images->byId.count("t_mine"), std::size_t{0});
}

// ---- GET /og/:id.png : canRead-gated serve, generic fallback -----------------------------

TEST(get_serves_a_stored_card_for_a_readable_tree_with_cache_headers) {
  Harness h;
  h.seed("t_pub", UserId{"owner"}, Visibility::public_);
  h.images->byId["t_pub"] = PNG;
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_pub");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->contentType(), drogon::CT_IMAGE_PNG);
  CHECK_EQ(resp->getHeader("Cache-Control"), std::string("public, max-age=300"));
  CHECK_EQ(resp->getBody(), PNG);
}

TEST(get_falls_back_to_the_generic_card_when_no_image_was_uploaded) {
  Harness h;
  h.seed("t_pub", UserId{"owner"}, Visibility::public_);
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_pub");

  CHECK_EQ(resp->getStatusCode(), drogon::k302Found);
  CHECK_EQ(resp->getHeader("Location"), std::string("/og-image.png"));
}

TEST(get_falls_back_to_the_generic_card_for_an_absent_tree) {
  Harness h;
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_ghost");

  CHECK_EQ(resp->getStatusCode(), drogon::k302Found);
  CHECK_EQ(resp->getHeader("Location"), std::string("/og-image.png"));
}

TEST(get_hides_a_private_trees_card_from_a_non_owner_behind_the_generic_fallback) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);
  h.images->byId["t_priv"] = PNG;
  OgImageApi api = h.make();

  drogon::HttpResponsePtr anon = sendGet(api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendGet(api, "s-other", "t_priv");

  CHECK_EQ(anon->getStatusCode(), drogon::k302Found);
  CHECK_EQ(anon->getHeader("Location"), std::string("/og-image.png"));
  CHECK_EQ(nonOwner->getStatusCode(), drogon::k302Found);
  CHECK_EQ(nonOwner->getHeader("Location"), std::string("/og-image.png"));
}

TEST(get_serves_a_private_trees_card_to_its_owner) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", me, Visibility::private_);
  h.images->byId["t_priv"] = PNG;
  OgImageApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "s-me", "t_priv");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->contentType(), drogon::CT_IMAGE_PNG);
  CHECK_EQ(resp->getBody(), PNG);
}
