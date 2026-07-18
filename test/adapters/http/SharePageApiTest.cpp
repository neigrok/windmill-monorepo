#include "adapters/http/SharePageApi.h"

#include "domain/LooseGraph.h"
#include "test/application/AuthFakes.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <string_view>

using namespace wm;
using namespace wm::fake;

namespace {

// A minimal SPA shell: the fenced unfurl block the server rewrites, a static icon and the
// module script outside the fence (which must survive a rewrite untouched).
const std::string SHELL =
    "<!doctype html>\n<html><head>\n"
    "  <link rel=\"icon\" href=\"/favicon.ico\" />\n"
    "  <!-- meta:unfurl:start -->\n"
    "  <title>Windmill root</title>\n"
    "  <meta property=\"og:title\" content=\"Windmill root\" />\n"
    "  <!-- meta:unfurl:end -->\n"
    "  <script type=\"module\" src=\"/src/main.jsx\"></script>\n"
    "</head><body></body></html>\n";

std::string makeWebRoot(const std::string& shell) {
  static int counter = 0;
  std::filesystem::path dir =
      std::filesystem::temp_directory_path() / ("wm-share-test-" + std::to_string(counter++));
  std::filesystem::create_directories(dir);
  std::ofstream out(dir / "index.html", std::ios::binary);
  out << shell;
  return dir.string();
}

struct Harness {
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>();
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus);
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, "https://windmill.works");

  SharePageApi make(const std::string& webRoot) { return SharePageApi{rooms, auth, webRoot}; }

  UserId signIn(const std::string& sessionSecret, const std::string& emailAddr = "sam@example.com") {
    User user = authRepo.createUser(Email{emailAddr}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void seed(const char* id, const char* title, const UserId& owner, Visibility visibility, int steps) {
    TreeData data;
    data.id = TreeId{std::string(id)};
    data.title = title;
    for (int i = 0; i < steps; ++i) {
      NodeSpec node;
      node.id = NodeId{"n" + std::to_string(i)};
      node.label = "Step " + std::to_string(i);
      data.nodes.push_back(node);
    }
    GraphState state = LooseGraph(data, Hlc{1, 0, "seed"}).exportState();
    trees->byId[id] = StoredTree{state, LegendState{}, {title, {}}, 0, owner, visibility};
  }
};

drogon::HttpRequestPtr getReq(const std::string& session) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr sendPage(SharePageApi& api, const std::string& session, const std::string& id) {
  drogon::HttpResponsePtr captured;
  api.page(getReq(session), [&](const drogon::HttpResponsePtr& r) { captured = r; }, id);
  return captured;
}

bool has(std::string_view body, std::string_view needle) {
  return body.find(needle) != std::string_view::npos;
}

}

// ---- renderShell: the pure templating boundary -------------------------------------------

TEST(render_shell_injects_the_trees_own_meta_and_keeps_the_sentinels) {
  std::string html = SharePageApi::renderShell(SHELL, "My Tree", 3, Visibility::unlisted, "t_abc");

  CHECK(has(html, "<!-- meta:unfurl:start -->"));
  CHECK(has(html, "<!-- meta:unfurl:end -->"));
  CHECK(has(html, "<title>My Tree \xE2\x80\x94 Windmill</title>"));
  CHECK(has(html, "content=\"My Tree\""));  // og:title + twitter:title
  CHECK(has(html, "A Windmill skill tree \xE2\x80\x94 3 steps."));
  CHECK(has(html, "href=\"https://windmill.works/t/t_abc\""));
  CHECK(has(html, "content=\"noindex\""));                  // unlisted is not indexable
  CHECK(has(html, "content=\"summary_large_image\""));      // large card preserved
  CHECK_FALSE(has(html, "Windmill root"));                  // the root title is gone
  CHECK(has(html, "/favicon.ico"));                         // static tags outside the fence survive
  CHECK(has(html, "/src/main.jsx"));
}

TEST(render_shell_uses_singular_step_and_makes_a_public_tree_indexable) {
  std::string html = SharePageApi::renderShell(SHELL, "Solo", 1, Visibility::public_, "t_x");
  CHECK(has(html, "A Windmill skill tree \xE2\x80\x94 1 step."));
  CHECK(has(html, "content=\"index, follow, max-image-preview:large\""));
}

TEST(render_shell_html_escapes_the_title) {
  std::string html = SharePageApi::renderShell(SHELL, "<script>alert(1)</script>&\"x", 2, Visibility::unlisted, "t_x");
  CHECK_FALSE(has(html, "<script>alert(1)"));
  CHECK(has(html, "&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;x"));
}

TEST(render_shell_falls_back_to_untitled_and_returns_a_fenceless_shell_unchanged) {
  std::string named = SharePageApi::renderShell(SHELL, "", 2, Visibility::unlisted, "t_x");
  CHECK(has(named, "<title>Untitled tree \xE2\x80\x94 Windmill</title>"));

  const std::string fenceless = "<html><head><title>No fence</title></head></html>";
  CHECK_EQ(SharePageApi::renderShell(fenceless, "T", 2, Visibility::public_, "t_x"), fenceless);
}

// ---- page(): read gating + response shape ------------------------------------------------

TEST(page_serves_an_unlisted_tree_with_its_meta_and_cache_headers) {
  Harness h;
  h.seed("t_shared", "Shared plan", UserId{"owner"}, Visibility::unlisted, 2);
  SharePageApi api = h.make(makeWebRoot(SHELL));

  drogon::HttpResponsePtr resp = sendPage(api, "", "t_shared");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK_EQ(resp->getHeader("Cache-Control"), std::string("public, max-age=300"));
  CHECK_EQ(resp->contentType(), drogon::CT_TEXT_HTML);
  CHECK(has(resp->getBody(), "content=\"Shared plan\""));
  CHECK(has(resp->getBody(), "A Windmill skill tree \xE2\x80\x94 2 steps."));
  CHECK(has(resp->getBody(), "href=\"https://windmill.works/t/t_shared\""));
}

TEST(page_private_denial_is_byte_identical_to_absent_and_to_the_raw_shell) {
  Harness h;
  h.signIn("s-other", "other@example.com");  // a signed-in non-owner
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_, 2);
  SharePageApi api = h.make(makeWebRoot(SHELL));

  drogon::HttpResponsePtr anon = sendPage(api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendPage(api, "s-other", "t_priv");
  drogon::HttpResponsePtr absent = sendPage(api, "", "t_ghost");

  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(absent->getStatusCode(), drogon::k200OK);
  CHECK_EQ(anon->getBody(), SHELL);  // verbatim — no tree meta spliced in
  CHECK_EQ(anon->getBody(), absent->getBody());       // private == absent
  CHECK_EQ(nonOwner->getBody(), absent->getBody());
  CHECK_FALSE(has(anon->getBody(), "Secret"));
}

TEST(page_owner_sees_their_private_trees_meta_but_it_stays_noindex) {
  Harness h;
  UserId me = h.signIn("s-me");
  h.seed("t_mine", "My private plan", me, Visibility::private_, 2);
  SharePageApi api = h.make(makeWebRoot(SHELL));

  drogon::HttpResponsePtr resp = sendPage(api, "s-me", "t_mine");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK(has(resp->getBody(), "content=\"My private plan\""));
  CHECK(has(resp->getBody(), "content=\"noindex\""));
}

TEST(page_falls_back_to_a_hash_redirect_when_the_web_root_is_missing) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted, 2);
  SharePageApi api = h.make("");  // no web root configured

  drogon::HttpResponsePtr resp = sendPage(api, "", "t_shared");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK(has(resp->getBody(), "url=/#/t/t_shared"));
}
