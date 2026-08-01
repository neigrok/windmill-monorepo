#include "products/roadmap/adapters/http/OgVideoApi.h"

#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <memory>
#include <optional>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

// The container magic every real upload leads with, plus a little payload. Both are built with an
// explicit-length prefix so a hex escape can't greedily swallow the byte that follows it.
const std::string MP4 = std::string("\x00\x00\x00\x18", 4) + "ftypisommp42" + "fake-loop-bytes";
const std::string WEBM = std::string("\x1a\x45\xdf\xa3", 4) + "fake-webm-loop-bytes";

struct Harness {
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>();
  std::shared_ptr<FakeOgVideoRepository> videos = std::make_shared<FakeOgVideoRepository>();
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");

  OgVideoApi make() { return OgVideoApi{videos, trees, auth}; }

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
  req->setContentTypeString("video/mp4");
  req->setBody(body);
  return req;
}

drogon::HttpRequestPtr getReq(const std::string& session) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr sendPut(OgVideoApi& api, const std::string& session, const std::string& id,
                                const std::string& body) {
  drogon::HttpResponsePtr captured;
  api.putVideo(putReq(session, body), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

drogon::HttpResponsePtr sendGet(OgVideoApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.getVideo(getReq(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

}

// ---- PUT /v1/trees/:id/og-video : owner-only upload --------------------------------------

TEST(put_stores_an_mp4_for_the_owner_as_video_mp4_and_answers_204) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_mine", MP4);

  CHECK_EQ(resp->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.videos->byId.count("t_mine"), std::size_t{1});
  CHECK_EQ(h.videos->byId["t_mine"].bytes, MP4);
  CHECK_EQ(h.videos->byId["t_mine"].mime, std::string("video/mp4"));
}

TEST(put_stores_a_webm_as_video_webm_and_answers_204) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_mine", WEBM);

  CHECK_EQ(resp->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(h.videos->byId["t_mine"].bytes, WEBM);
  CHECK_EQ(h.videos->byId["t_mine"].mime, std::string("video/webm"));
}

TEST(put_by_an_anonymous_caller_is_401_and_stores_nothing) {
  Harness h;
  h.seed("t_mine", UserId{"owner"}, Visibility::unlisted);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "", "t_mine", MP4);

  CHECK_EQ(resp->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(h.videos->byId.count("t_mine"), std::size_t{0});
}

TEST(put_by_a_signed_in_non_owner_is_403_and_stores_nothing) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_mine", UserId{"owner"}, Visibility::unlisted);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-other", "t_mine", MP4);

  CHECK_EQ(resp->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(h.videos->byId.count("t_mine"), std::size_t{0});
}

TEST(put_to_an_unclaimed_tree_is_403) {
  Harness h;
  h.signIn("s-me");
  h.seed("t_orphan", std::nullopt, Visibility::public_);  // no owner — nobody equals it
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_orphan", MP4);

  CHECK_EQ(resp->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(h.videos->byId.count("t_orphan"), std::size_t{0});
}

TEST(put_to_an_absent_tree_is_404) {
  Harness h;
  h.signIn("s-me");
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_ghost", MP4);

  CHECK_EQ(resp->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(h.videos->byId.count("t_ghost"), std::size_t{0});
}

TEST(put_over_the_3mb_cap_is_413_even_with_a_valid_container) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgVideoApi api = h.make();
  std::string tooBig = std::string("\x00\x00\x00\x18", 4) + "ftypisom" + std::string(3 * 1024 * 1024, 'x');

  drogon::HttpResponsePtr resp = sendPut(api, "s-me", "t_mine", tooBig);

  CHECK_EQ(resp->getStatusCode(), drogon::k413RequestEntityTooLarge);
  CHECK_EQ(h.videos->byId.count("t_mine"), std::size_t{0});
}

TEST(put_of_a_non_video_body_is_400) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", me, Visibility::unlisted);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr shortBody = sendPut(api, "s-me", "t_mine", "abc");
  drogon::HttpResponsePtr wrongMagic = sendPut(api, "s-me", "t_mine", "not-a-video-at-all!!");

  CHECK_EQ(shortBody->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(wrongMagic->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(h.videos->byId.count("t_mine"), std::size_t{0});
}

// ---- GET /v1/trees/:id/og-video : canRead-gated serve, 404 on any miss -------------------

TEST(get_serves_a_stored_video_with_its_mime_and_cache_headers_for_a_readable_tree) {
  Harness h;
  h.seed("t_pub", UserId{"owner"}, Visibility::public_);
  h.videos->byId["t_pub"] = StoredVideo{MP4, "video/mp4"};
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_pub");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->contentTypeString(), std::string("video/mp4"));
  CHECK_EQ(resp->getHeader("Cache-Control"), std::string("public, max-age=300"));
  CHECK_EQ(resp->getBody(), MP4);
}

TEST(get_echoes_a_webm_videos_stored_mime) {
  Harness h;
  h.seed("t_pub", UserId{"owner"}, Visibility::public_);
  h.videos->byId["t_pub"] = StoredVideo{WEBM, "video/webm"};
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_pub");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->contentTypeString(), std::string("video/webm"));
  CHECK_EQ(resp->getBody(), WEBM);
}

TEST(get_is_404_when_no_video_was_uploaded) {
  Harness h;
  h.seed("t_pub", UserId{"owner"}, Visibility::public_);
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_pub");

  CHECK_EQ(resp->getStatusCode(), drogon::k404NotFound);
}

TEST(get_is_404_for_an_absent_tree) {
  Harness h;
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "", "t_ghost");

  CHECK_EQ(resp->getStatusCode(), drogon::k404NotFound);
}

TEST(get_hides_a_private_trees_video_from_a_stranger_as_a_plain_404) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", UserId{"owner"}, Visibility::private_);
  h.videos->byId["t_priv"] = StoredVideo{MP4, "video/mp4"};
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr anon = sendGet(api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendGet(api, "s-other", "t_priv");

  CHECK_EQ(anon->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(nonOwner->getStatusCode(), drogon::k404NotFound);
}

TEST(get_serves_a_private_trees_video_to_its_owner) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_priv", me, Visibility::private_);
  h.videos->byId["t_priv"] = StoredVideo{MP4, "video/mp4"};
  OgVideoApi api = h.make();

  drogon::HttpResponsePtr resp = sendGet(api, "s-me", "t_priv");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->contentTypeString(), std::string("video/mp4"));
  CHECK_EQ(resp->getBody(), MP4);
}
