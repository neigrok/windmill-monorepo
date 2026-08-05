#include "products/roadmap/adapters/http/GalleryApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <memory>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// A minimal wall template: the fenced card block the server fills, with the designed empty state
// inside the fence and page chrome outside it (which must survive a fill untouched).
const std::string SHELL =
    "<!doctype html>\n<html><head><title>Gallery</title></head><body>\n"
    "  <main>\n"
    "      <!-- wall:cards:start -->\n"
    "      <p class=\"empty\">No trees yet.</p>\n"
    "      <!-- wall:cards:end -->\n"
    "  </main>\n"
    "  <footer>Windmill</footer>\n"
    "</body></html>\n";

GalleryEntry entry(const char* id, const char* title, int done, int total, int forks,
                   std::optional<NodeColor> hue = NodeColor::sky) {
  GalleryEntry row;
  row.id = TreeId{std::string(id)};
  row.title = title;
  row.stats.done = done;
  row.stats.total = total;
  row.stats.dominantKind = hue;
  row.forks = forks;
  return row;
}

bool contains(const std::string& haystack, const std::string& needle) {
  return haystack.find(needle) != std::string::npos;
}

// The JSON surface's whole stack behind the endpoint: the tree store, the owner-overlay store the
// wall joins, and the auth boundary that turns a cookie into a reader. No web root — GET
// /v1/gallery never reads one.
struct Harness {
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>();
  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  GalleryApi api{trees, progress, auth, ""};

  UserId signIn(const std::string& sessionSecret, const std::string& address) {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }

  void seed(const char* id, const char* title, const UserId& owner, Visibility visibility, int steps,
            std::uint64_t updatedAt = 100) {
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
    trees->updatedAt[id] = updatedAt;
  }

  void seedFork(const char* forkId, const char* sourceId) { trees->forkedFrom[forkId] = sourceId; }

  // The owner ticked a step. It lands on the wall row exactly where the lateral join puts it, and
  // — the whole point — the tree's own structural stamp stays where it was.
  void seedMark(const char* id, std::uint64_t markedAt) { trees->lastMarkedAt[id] = markedAt; }
};

drogon::HttpRequestPtr galleryReq(const std::string& session = "", const std::string& limit = "",
                                  const std::string& cursor = "") {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  req->setPath("/v1/gallery");
  if (!session.empty()) req->addCookie("wm_session", session);
  if (!limit.empty()) req->setParameter("limit", limit);
  if (!cursor.empty()) req->setParameter("cursor", cursor);
  return req;
}

drogon::HttpResponsePtr sendIndex(GalleryApi& api, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  api.index(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

TEST(an_empty_wall_serves_the_templates_own_empty_state) {
  const std::string page = GalleryApi::renderWall(SHELL, {});

  CHECK_EQ(page, SHELL);  // byte-identical — the designed empty state is what ships
}

TEST(a_card_is_a_real_anchor_to_the_trees_share_page) {
  const std::string page = GalleryApi::renderWall(SHELL, {entry("t_abc", "Learn Rust", 3, 12, 0)});

  CHECK(contains(page, "href=\"/t/t_abc\""));
  CHECK(contains(page, "src=\"/og/t_abc.png\""));
  CHECK(contains(page, ">Learn Rust<"));
  CHECK(contains(page, "3/12 done"));
  CHECK(contains(page, "width:25%"));  // 3 of 12
  CHECK_FALSE(contains(page, "No trees yet."));  // the empty state is gone
  CHECK(contains(page, "<footer>Windmill</footer>"));  // chrome outside the fence survives
}

TEST(a_card_shows_forks_only_once_it_has_them) {
  const std::string unforked = GalleryApi::renderWall(SHELL, {entry("t_a", "A", 0, 5, 0)});
  CHECK_FALSE(contains(unforked, "forked"));

  const std::string once = GalleryApi::renderWall(SHELL, {entry("t_b", "B", 0, 5, 1)});
  CHECK(contains(once, "forked 1 time<"));

  const std::string many = GalleryApi::renderWall(SHELL, {entry("t_c", "C", 0, 5, 4)});
  CHECK(contains(many, "forked 4 times<"));
}

TEST(a_card_wears_its_trees_dominant_hue) {
  const std::string page = GalleryApi::renderWall(SHELL, {entry("t_a", "A", 0, 5, 0, NodeColor::plum)});
  CHECK(contains(page, "background:#8D4F83"));

  // A tree with no dominant kind (it has none to be dominant) still gets a bar, in the default hue.
  const std::string bare = GalleryApi::renderWall(SHELL, {entry("t_b", "B", 0, 5, 0, std::nullopt)});
  CHECK(contains(bare, "background:#BC6C42"));
}

TEST(a_title_carrying_markup_is_escaped_not_rendered) {
  const std::string page =
      GalleryApi::renderWall(SHELL, {entry("t_x", "<script>alert('x')</script>", 0, 5, 0)});

  CHECK_FALSE(contains(page, "<script>alert"));
  CHECK(contains(page, "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
}

TEST(a_template_missing_its_fence_is_served_untouched) {
  const std::string fenceless = "<!doctype html><body><main></main></body>";

  const std::string page = GalleryApi::renderWall(fenceless, {entry("t_a", "A", 0, 5, 0)});

  CHECK_EQ(page, fenceless);  // never half-rewritten
}

TEST(every_entry_lands_on_the_wall_in_the_order_it_was_given) {
  const std::string page = GalleryApi::renderWall(
      SHELL, {entry("t_1", "First", 0, 5, 9), entry("t_2", "Second", 0, 5, 4), entry("t_3", "Third", 0, 5, 1)});

  const std::size_t first = page.find("/t/t_1");
  const std::size_t second = page.find("/t/t_2");
  const std::size_t third = page.find("/t/t_3");
  CHECK(first != std::string::npos);
  CHECK(first < second);
  CHECK(second < third);
}

TEST(a_forked_card_names_the_tree_it_came_from_and_never_the_person) {
  GalleryEntry row = entry("t_fork", "My Rust", 1, 5, 0);
  row.sourceTitle = "Learn Rust";

  const std::string page = GalleryApi::renderWall(SHELL, {row});

  CHECK(contains(page, "A fork of \xE2\x80\x9CLearn Rust\xE2\x80\x9D"));
  // A card with no lineage says nothing at all about a source.
  CHECK_FALSE(contains(GalleryApi::renderWall(SHELL, {entry("t_own", "Own", 1, 5, 0)}), "A fork of"));
}

TEST(a_source_title_carrying_markup_is_escaped_not_rendered) {
  GalleryEntry row = entry("t_fork", "My Rust", 1, 5, 0);
  row.sourceTitle = "<script>alert('x')</script>";

  const std::string page = GalleryApi::renderWall(SHELL, {row});

  CHECK_FALSE(contains(page, "<script>alert"));
  CHECK(contains(page, "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
}

TEST(the_json_index_serves_an_anonymous_caller_the_walls_own_rows) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_popular", "Popular", owner, Visibility::public_, 5, 100);
  h.seed("t_quiet", "Quiet", owner, Visibility::public_, 5, 100);
  h.seed("t_unlisted", "Unlisted", owner, Visibility::unlisted, 5, 100);
  h.seed("t_private", "Private", owner, Visibility::private_, 5, 100);
  h.seedFork("t_copy", "t_popular");
  h.seed("t_copy", "Copy", owner, Visibility::private_, 5, 100);

  const Json::Value body = bodyOf(sendIndex(h.api, galleryReq()));

  CHECK_EQ(body["count"].asUInt(), 2u);  // never the unlisted or the private tree
  REQUIRE_EQ(body["entries"].size(), 2u);
  CHECK_EQ(body["entries"][0]["id"].asString(), std::string("t_popular"));  // one fork outranks none
  CHECK_EQ(body["entries"][0]["title"].asString(), std::string("Popular"));
  CHECK_EQ(body["entries"][0]["total"].asInt(), 5);
  CHECK_EQ(body["entries"][0]["done"].asInt(), 0);
  CHECK_EQ(body["entries"][0]["forks"].asInt(), 1);
  CHECK_FALSE(body["entries"][0]["mine"].asBool());
  CHECK_FALSE(body["entries"][0]["forked"].asBool());
  CHECK_EQ(body["entries"][1]["id"].asString(), std::string("t_quiet"));
  CHECK_FALSE(body.isMember("nextCursor"));
}

TEST(the_json_index_tells_a_signed_in_caller_what_is_theirs_and_what_they_took) {
  Harness h;
  const UserId sam = h.signIn("s1", "sam@example.com");
  const UserId other = h.signIn("s2", "other@example.com");
  h.seed("t_mine", "Mine", sam, Visibility::public_, 5, 100);
  h.seed("t_taken", "Taken", other, Visibility::public_, 5, 100);
  h.seed("t_stranger", "Stranger's", other, Visibility::public_, 5, 100);
  // Sam's own copy of t_taken: private, so it is not itself on the wall — it is only the record
  // that says he has already taken that plan.
  h.seed("t_samscopy", "Taken (mine)", sam, Visibility::private_, 5, 100);
  h.seedFork("t_samscopy", "t_taken");

  const Json::Value body = bodyOf(sendIndex(h.api, galleryReq("s1")));

  CHECK_EQ(body["count"].asUInt(), 3u);
  CHECK_EQ(body["entries"][0]["id"].asString(), std::string("t_taken"));  // one fork, so it leads
  CHECK_FALSE(body["entries"][0]["mine"].asBool());
  CHECK(body["entries"][0]["forked"].asBool());
  CHECK_EQ(body["entries"][1]["id"].asString(), std::string("t_mine"));
  CHECK(body["entries"][1]["mine"].asBool());
  CHECK_FALSE(body["entries"][1]["forked"].asBool());
  CHECK_EQ(body["entries"][2]["id"].asString(), std::string("t_stranger"));
  CHECK_FALSE(body["entries"][2]["mine"].asBool());
  CHECK_FALSE(body["entries"][2]["forked"].asBool());

  // The same rows to a stranger, with both facts back to false — a session adds facts, never trees.
  const Json::Value anonymous = bodyOf(sendIndex(h.api, galleryReq()));
  CHECK_EQ(anonymous["count"].asUInt(), 3u);
  for (const Json::Value& row : anonymous["entries"]) {
    CHECK_FALSE(row["mine"].asBool());
    CHECK_FALSE(row["forked"].asBool());
  }
}

TEST(a_listed_fork_names_its_source_only_while_that_source_is_public) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_source", "Learn Rust", owner, Visibility::public_, 5, 100);
  h.seed("t_fork", "My Rust", owner, Visibility::public_, 5, 100);
  h.seedFork("t_fork", "t_source");

  const Json::Value named = bodyOf(sendIndex(h.api, galleryReq()));
  CHECK_EQ(named["entries"][0]["id"].asString(), std::string("t_source"));  // the fork it inspired
  CHECK_FALSE(named["entries"][0].isMember("sourceTitle"));
  CHECK_EQ(named["entries"][1]["id"].asString(), std::string("t_fork"));
  CHECK_EQ(named["entries"][1]["sourceTitle"].asString(), std::string("Learn Rust"));

  // The owner pulls the source back to unlisted: the fork stays on the wall, but stops naming it.
  h.trees->setVisibility(TreeId{"t_source"}, Visibility::unlisted);
  const Json::Value anonymousSource = bodyOf(sendIndex(h.api, galleryReq()));
  CHECK_EQ(anonymousSource["count"].asUInt(), 1u);
  CHECK_EQ(anonymousSource["entries"][0]["id"].asString(), std::string("t_fork"));
  CHECK_FALSE(anonymousSource["entries"][0].isMember("sourceTitle"));
}

TEST(the_json_index_ranks_a_tended_tree_above_a_newer_one_nobody_has_opened) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_abandoned", "Abandoned", owner, Visibility::public_, 5, 500);
  h.seed("t_tended", "Tended", owner, Visibility::public_, 5, 100);
  h.seedMark("t_tended", 900);

  const Json::Value body = bodyOf(sendIndex(h.api, galleryReq()));

  CHECK_EQ(body["count"].asUInt(), 2u);
  CHECK_EQ(body["entries"][0]["id"].asString(), std::string("t_tended"));
  CHECK_EQ(body["entries"][0]["updatedAt"].asInt64(), Json::Int64{900});
  CHECK_EQ(body["entries"][1]["id"].asString(), std::string("t_abandoned"));
  CHECK_EQ(body["entries"][1]["updatedAt"].asInt64(), Json::Int64{500});
}

TEST(the_json_index_pages_with_a_cursor_and_never_reshuffles) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_a", "A", owner, Visibility::public_, 5, 300);
  h.seed("t_b", "B", owner, Visibility::public_, 5, 200);
  h.seed("t_c", "C", owner, Visibility::public_, 5, 100);

  const Json::Value first = bodyOf(sendIndex(h.api, galleryReq("", "2")));
  CHECK_EQ(first["count"].asUInt(), 3u);  // the whole index, not this page
  REQUIRE_EQ(first["entries"].size(), 2u);
  CHECK_EQ(first["entries"][0]["id"].asString(), std::string("t_a"));
  CHECK_EQ(first["entries"][1]["id"].asString(), std::string("t_b"));
  CHECK_EQ(first["nextCursor"].asString(), std::string("t_b"));

  const Json::Value second = bodyOf(sendIndex(h.api, galleryReq("", "2", first["nextCursor"].asString())));
  CHECK_EQ(second["count"].asUInt(), 3u);
  REQUIRE_EQ(second["entries"].size(), 1u);
  CHECK_EQ(second["entries"][0]["id"].asString(), std::string("t_c"));
  CHECK_FALSE(second.isMember("nextCursor"));
}

TEST(the_json_index_refuses_a_limit_it_cannot_read_or_will_not_serve) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_a", "A", owner, Visibility::public_, 5, 100);

  for (const char* bad : {"0", "-4", "61", "many", "2cards", "2.5"}) {
    const drogon::HttpResponsePtr response = sendIndex(h.api, galleryReq("", bad));
    CHECK_EQ(response->statusCode(), drogon::k400BadRequest);
    CHECK_EQ(bodyOf(response)["code"].asString(), std::string("bad-limit"));
  }
}

TEST(the_json_index_refuses_a_cursor_naming_no_tree_rather_than_restarting) {
  Harness h;
  const UserId owner = h.signIn("s1", "owner@example.com");
  h.seed("t_a", "A", owner, Visibility::public_, 5, 100);

  const drogon::HttpResponsePtr response = sendIndex(h.api, galleryReq("", "", "t_gone"));

  CHECK_EQ(response->statusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(response)["code"].asString(), std::string("unknown-cursor"));
}

TEST(an_empty_gallery_is_an_empty_list_never_an_error) {
  Harness h;

  const drogon::HttpResponsePtr response = sendIndex(h.api, galleryReq());

  CHECK_EQ(response->statusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response)["count"].asUInt(), 0u);
  CHECK_EQ(bodyOf(response)["entries"].size(), 0u);
}
