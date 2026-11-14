#include "products/roadmap/adapters/http/SharePageApi.h"

#include "platform/application/WriteObservation.h"
#include "platform/ports/FailureReporter.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// A minimal SPA shell: the fenced unfurl block the server rewrites, plus static tags outside the fence.
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
  std::shared_ptr<FakeOgVideoRepository> videos = std::make_shared<FakeOgVideoRepository>();
  std::shared_ptr<FakeOpLog> ops = std::make_shared<FakeOpLog>();
  FakeBus bus;
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<RoomRegistry> rooms = std::make_shared<RoomRegistry>(*trees, *ops, bus);
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");

  SharePageApi make(const std::string& webRoot) { return SharePageApi{rooms, trees, auth, videos, webRoot, "https://share.example"}; }

  void seedFork(const char* forkId, const char* sourceId) { trees->forkedFrom[forkId] = sourceId; }

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
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "My Tree", 3, Visibility::unlisted, "t_abc", ForkLineage{}, false);

  CHECK(has(html, "<!-- meta:unfurl:start -->"));
  CHECK(has(html, "<!-- meta:unfurl:end -->"));
  CHECK(has(html, "<title>My Tree \xE2\x80\x94 Windmill</title>"));
  CHECK(has(html, "content=\"My Tree\""));  // og:title + twitter:title
  CHECK(has(html, "A Windmill skill tree \xE2\x80\x94 3 steps."));
  CHECK(has(html, "href=\"https://share.example/t/t_abc\""));
  CHECK(has(html, "content=\"https://share.example/og/t_abc.png\""));  // per-tree og:image + twitter:image
  CHECK_FALSE(has(html, "og-image.png"));
  CHECK_FALSE(has(html, "og:video"));                       // no uploaded loop → no video tag, only the poster
  CHECK(has(html, "content=\"noindex\""));                  // unlisted is not indexable
  CHECK(has(html, "content=\"summary_large_image\""));      // large card preserved
  CHECK_FALSE(has(html, "Windmill root"));
  CHECK(has(html, "/favicon.ico"));
  CHECK(has(html, "/src/main.jsx"));
}

TEST(render_shell_emits_the_video_tags_alongside_the_poster_when_a_loop_exists) {
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "My Tree", 3, Visibility::unlisted, "t_abc", ForkLineage{}, true);

  CHECK(has(html, "content=\"https://share.example/og/t_abc.png\""));
  CHECK(has(html, "<meta property=\"og:video\" content=\"https://share.example/v1/trees/t_abc/og-video\" />"));
  CHECK(has(html, "<meta property=\"og:video:secure_url\" content=\"https://share.example/v1/trees/t_abc/og-video\" />"));
  CHECK(has(html, "<meta property=\"og:video:type\" content=\"video/mp4\" />"));
  CHECK(has(html, "<meta property=\"og:video:width\" content=\"1080\" />"));
  CHECK(has(html, "<meta property=\"og:video:height\" content=\"1080\" />"));
}

// The page's own address and its pictures are all built on the origin: one ending in '/' does not double it, and an
// origin holding markup characters lands escaped in every tag that carries it.
TEST(render_shell_builds_every_address_on_the_origin_without_doubling_or_unescaping_it) {
  const auto tagsOf = [](const std::string& origin) {
    const std::string html = SharePageApi::renderShell(SHELL, origin, "T", 1, Visibility::public_, "t_9362d9bc883e0a1e",
                                                       ForkLineage{}, true);
    std::vector<std::string> tags;
    for (const char* key : {"rel=\"canonical\"", "\"og:url\"", "\"og:image\"", "\"og:video\"",
                            "\"og:video:secure_url\"", "\"twitter:image\""}) {
      const std::size_t start = html.rfind('<', html.find(key));
      tags.push_back(html.substr(start, html.find('\n', start) - start));
    }
    return tags;
  };

  CHECK_EQ(tagsOf("https://share.example/"),
           (std::vector<std::string>{
               "<link rel=\"canonical\" href=\"https://share.example/t/t_9362d9bc883e0a1e\" />",
               "<meta property=\"og:url\" content=\"https://share.example/t/t_9362d9bc883e0a1e\" />",
               "<meta property=\"og:image\" content=\"https://share.example/og/t_9362d9bc883e0a1e.png\" />",
               "<meta property=\"og:video\" content=\"https://share.example/v1/trees/t_9362d9bc883e0a1e/og-video\" />",
               "<meta property=\"og:video:secure_url\" content=\"https://share.example/v1/trees/t_9362d9bc883e0a1e/og-video\" />",
               "<meta name=\"twitter:image\" content=\"https://share.example/og/t_9362d9bc883e0a1e.png\" />"}));
  CHECK_EQ(tagsOf("https://x.example/a\"b<c>"),
           (std::vector<std::string>{
               "<link rel=\"canonical\" href=\"https://x.example/a&quot;b&lt;c&gt;/t/t_9362d9bc883e0a1e\" />",
               "<meta property=\"og:url\" content=\"https://x.example/a&quot;b&lt;c&gt;/t/t_9362d9bc883e0a1e\" />",
               "<meta property=\"og:image\" content=\"https://x.example/a&quot;b&lt;c&gt;/og/t_9362d9bc883e0a1e.png\" />",
               "<meta property=\"og:video\" content=\"https://x.example/a&quot;b&lt;c&gt;/v1/trees/t_9362d9bc883e0a1e/og-video\" />",
               "<meta property=\"og:video:secure_url\" content=\"https://x.example/a&quot;b&lt;c&gt;/v1/trees/t_9362d9bc883e0a1e/og-video\" />",
               "<meta name=\"twitter:image\" content=\"https://x.example/a&quot;b&lt;c&gt;/og/t_9362d9bc883e0a1e.png\" />"}));
}

TEST(render_shell_uses_singular_step_and_makes_a_public_tree_indexable) {
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "Solo", 1, Visibility::public_, "t_x", ForkLineage{}, false);
  CHECK(has(html, "A Windmill skill tree \xE2\x80\x94 1 step."));
  CHECK(has(html, "content=\"index, follow, max-image-preview:large\""));
}

TEST(render_shell_names_a_public_source_and_counts_forks) {
  ForkLineage lineage;
  lineage.isFork = true;
  lineage.sourceTitle = "Learn to sail";
  lineage.forkCount = 12;
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "My voyage", 5, Visibility::unlisted, "t_x", lineage, false);
  CHECK(has(html, "A fork of \xE2\x80\x9CLearn to sail\xE2\x80\x9D \xE2\x80\x94 5 steps. Forked 12 times."));
}

TEST(render_shell_keeps_an_unnamed_source_anonymous_and_singularizes_one_fork) {
  ForkLineage lineage;
  lineage.isFork = true;  // sourceTitle empty — the source was unlisted/private, never revealed
  lineage.forkCount = 1;
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "Mine", 3, Visibility::unlisted, "t_x", lineage, false);
  CHECK(has(html, "A forked Windmill skill tree \xE2\x80\x94 3 steps. Forked 1 time."));
  CHECK_FALSE(has(html, "A fork of"));  // no source named
}

TEST(render_shell_escapes_a_forked_source_title) {
  ForkLineage lineage;
  lineage.isFork = true;
  lineage.sourceTitle = "<b>x</b>";
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "Mine", 2, Visibility::unlisted, "t_x", lineage, false);
  CHECK(has(html, "&lt;b&gt;x&lt;/b&gt;"));
  CHECK_FALSE(has(html, "<b>x</b>"));
}

TEST(render_shell_html_escapes_the_title) {
  std::string html = SharePageApi::renderShell(SHELL, "https://share.example", "<script>alert(1)</script>&\"x", 2, Visibility::unlisted, "t_x", ForkLineage{}, false);
  CHECK_FALSE(has(html, "<script>alert(1)"));
  CHECK(has(html, "&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;x"));
}

TEST(render_shell_falls_back_to_untitled_and_returns_a_fenceless_shell_unchanged) {
  std::string named = SharePageApi::renderShell(SHELL, "https://share.example", "", 2, Visibility::unlisted, "t_x", ForkLineage{}, false);
  CHECK(has(named, "<title>Untitled tree \xE2\x80\x94 Windmill</title>"));

  const std::string fenceless = "<html><head><title>No fence</title></head></html>";
  CHECK_EQ(SharePageApi::renderShell(fenceless, "https://share.example", "T", 2, Visibility::public_, "t_x", ForkLineage{}, false), fenceless);
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
  CHECK(has(resp->getBody(), "href=\"https://share.example/t/t_shared\""));
}

TEST(page_of_a_fork_names_its_public_source_and_counts_its_own_forks) {
  Harness h;
  h.seed("t_src", "Learn to sail", UserId{"owner"}, Visibility::public_, 4);   // the public origin
  h.seed("t_fork", "My voyage", UserId{"me"}, Visibility::unlisted, 5);        // an unlisted fork of it
  h.seedFork("t_fork", "t_src");
  h.seed("t_grandchild", "Their voyage", UserId{"other"}, Visibility::unlisted, 3);
  h.seedFork("t_grandchild", "t_fork");                                        // one fork OF the fork
  SharePageApi api = h.make(makeWebRoot(SHELL));

  std::string body{sendPage(api, "", "t_fork")->getBody()};
  CHECK(has(body, "A fork of \xE2\x80\x9CLearn to sail\xE2\x80\x9D \xE2\x80\x94 5 steps. Forked 1 time."));
}

TEST(page_of_a_fork_hides_an_unlisted_source_title) {
  Harness h;
  h.seed("t_src", "Someone's private-ish plan", UserId{"owner"}, Visibility::unlisted, 4);  // not public
  h.seed("t_fork", "My copy", UserId{"me"}, Visibility::unlisted, 2);
  h.seedFork("t_fork", "t_src");
  SharePageApi api = h.make(makeWebRoot(SHELL));

  std::string body{sendPage(api, "", "t_fork")->getBody()};
  CHECK(has(body, "A forked Windmill skill tree \xE2\x80\x94 2 steps."));
  CHECK_FALSE(has(body, "Someone's private-ish plan"));
}

TEST(page_private_denial_is_byte_identical_to_absent_and_to_the_raw_shell) {
  Harness h;
  h.signIn("s-other", "other@example.com");
  h.seed("t_priv", "Secret", UserId{"owner"}, Visibility::private_, 2);
  SharePageApi api = h.make(makeWebRoot(SHELL));

  drogon::HttpResponsePtr anon = sendPage(api, "", "t_priv");
  drogon::HttpResponsePtr nonOwner = sendPage(api, "s-other", "t_priv");
  drogon::HttpResponsePtr absent = sendPage(api, "", "t_ghost");

  CHECK_EQ(anon->getStatusCode(), drogon::k200OK);
  CHECK_EQ(absent->getStatusCode(), drogon::k200OK);
  CHECK_EQ(anon->getBody(), SHELL);
  CHECK_EQ(anon->getBody(), absent->getBody());
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

TEST(page_advertises_og_video_only_when_the_tree_carries_an_uploaded_loop) {
  Harness h;
  h.seed("t_withvideo", "Has a loop", UserId{"owner"}, Visibility::unlisted, 2);
  h.seed("t_novideo", "No loop", UserId{"owner"}, Visibility::unlisted, 2);
  h.videos->byId["t_withvideo"] = StoredVideo{"mp4-bytes", "video/mp4"};
  SharePageApi api = h.make(makeWebRoot(SHELL));

  std::string withVideo{sendPage(api, "", "t_withvideo")->getBody()};
  std::string noVideo{sendPage(api, "", "t_novideo")->getBody()};

  CHECK(has(withVideo, "<meta property=\"og:video\" content=\"https://share.example/v1/trees/t_withvideo/og-video\" />"));
  CHECK(has(withVideo, "content=\"https://share.example/og/t_withvideo.png\""));
  CHECK_FALSE(has(noVideo, "og:video"));
  CHECK(has(noVideo, "content=\"https://share.example/og/t_novideo.png\""));
}

TEST(page_falls_back_to_a_hash_redirect_when_the_web_root_is_missing) {
  Harness h;
  h.seed("t_shared", "Shared", UserId{"owner"}, Visibility::unlisted, 2);
  SharePageApi api = h.make("");

  drogon::HttpResponsePtr resp = sendPage(api, "", "t_shared");

  CHECK_EQ(resp->getStatusCode(), drogon::k200OK);
  CHECK(has(resp->getBody(), "url=/#/t/t_shared"));
}

// A subtree's own link opens it for anyone who may read its root, named by its owning step's label and indexed as its
// root is: a private root keeps it from a stranger, whose page is the raw shell.
TEST(page_of_a_subtree_names_it_by_its_owning_step_and_follows_its_roots_visibility) {
  Harness h;
  h.seed("t_root", "My year", UserId{"owner"}, Visibility::public_, 2);
  h.seed("t_sail", "", UserId{"owner"}, Visibility::private_, 3);
  h.trees->subtrees["t_sail"] =
      Subtree{TreeId{"t_sail"}, TreeId{"t_root"}, OwningStep{TreeId{"t_root"}, NodeId{"n1"}}, 1, 0};
  SharePageApi api = h.make(makeWebRoot(SHELL));

  const drogon::HttpResponsePtr shared = sendPage(api, "", "t_sail");
  CHECK(has(shared->getBody(), "<title>Step 1 \xE2\x80\x94 Windmill</title>"));
  CHECK(has(shared->getBody(), "A Windmill skill tree \xE2\x80\x94 3 steps."));
  CHECK(has(shared->getBody(), "content=\"index, follow, max-image-preview:large\""));

  h.rooms->sweep(std::chrono::steady_clock::duration::zero());
  h.trees->byId["t_root"].visibility = Visibility::private_;
  CHECK_EQ(std::string(sendPage(api, "", "t_sail")->getBody()), SHELL);
}

// The share page's reads report what fails, each under its own operation at door `share`: the tree's access and room
// under `roadmap.share.read`, a subtree's name under `roadmap.tree.place`. Either way the page is the shell, verbatim,
// and never a subtree's own title register.
TEST(page_whose_reads_fail_serves_the_shell_and_reports_each_failure_under_its_own_operation) {
  struct Failures : FailureReporter {
    std::vector<std::string> reports;
    void report(const std::string&, const std::string&, const std::string&) override {}
    void reportWrite(const std::string& operation, const std::string&, const std::string& door, const std::string& outcome,
                     const std::string&, const std::string&) override {
      reports.push_back(operation + " " + door + " " + outcome);
    }
  };
  std::shared_ptr<Failures> failures = std::make_shared<Failures>();
  installWriteReporter(failures);
  Harness h;
  h.seed("t_root", "My year", UserId{"owner"}, Visibility::public_, 2);
  h.seed("t_sail", "Its own register", UserId{"owner"}, Visibility::private_, 3);
  h.trees->subtrees["t_sail"] =
      Subtree{TreeId{"t_sail"}, TreeId{"t_root"}, OwningStep{TreeId{"t_root"}, NodeId{"n1"}}, 1, 0};
  SharePageApi api = h.make(makeWebRoot(SHELL));

  h.trees->accessReadsFail = true;
  const std::string unreadAccess{sendPage(api, "", "t_root")->getBody()};
  h.trees->accessReadsFail = false;
  h.trees->placeReadsFail = true;
  const drogon::HttpResponsePtr unnamed = sendPage(api, "", "t_sail");
  installWriteReporter(nullptr);

  CHECK_EQ(unreadAccess, SHELL);
  CHECK_EQ(unnamed->getStatusCode(), drogon::k200OK);
  CHECK_EQ(std::string(unnamed->getBody()), SHELL);
  CHECK_EQ(failures->reports, (std::vector<std::string>{"roadmap.share.read share failed", "roadmap.tree.place share failed"}));
}
