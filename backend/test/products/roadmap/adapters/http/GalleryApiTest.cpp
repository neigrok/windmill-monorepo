#include "products/roadmap/adapters/http/GalleryApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include "platform/application/WriteObservation.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// A minimal wall template: the fenced card block the server fills, with the empty state inside the fence and chrome outside it.
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

struct Harness {
  std::shared_ptr<FakeProgressRepository> progress = std::make_shared<FakeProgressRepository>();
  std::shared_ptr<FakeTreeRepository> trees = std::make_shared<FakeTreeRepository>(*progress);
  FakeTokens tokens;
  FakeClock clock;
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  std::shared_ptr<OwnerProgress> ownerProgress = std::make_shared<OwnerProgress>(*progress, *trees, clock);
  GalleryApi api{trees, ownerProgress, auth, ""};

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

  // A tree of the steps named, each opening the tree given beside it, or none for "".
  void seedSteps(const char* id, const UserId& owner, Visibility visibility,
                 const std::vector<std::pair<const char*, const char*>>& steps) {
    LooseGraph graph;
    for (const auto& [step, opens] : steps) {
      graph.createNode(NodeId{step}, step, "", NodeColor::sky, Hlc{1, 0, "seed"});
      if (std::string(opens) != "") graph.setOpens(NodeId{step}, TreeId{opens}, Hlc{2, 0, "seed"});
    }
    trees->byId[id] = StoredTree{graph.exportState(), LegendState{}, {id, {}}, 0, owner, visibility};
  }

  void seedFork(const char* forkId, const char* sourceId) { trees->forkedFrom[forkId] = sourceId; }
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

  CHECK_EQ(page, SHELL);
}

TEST(a_card_is_a_real_anchor_to_the_trees_share_page) {
  const std::string page = GalleryApi::renderWall(SHELL, {entry("t_abc", "Learn Rust", 3, 12, 0)});

  CHECK(contains(page, "href=\"/t/t_abc\""));
  CHECK(contains(page, "src=\"/og/t_abc.png\""));
  CHECK(contains(page, ">Learn Rust<"));
  CHECK(contains(page, "3/12 done"));
  CHECK(contains(page, "width:25%"));  // 3 of 12
  CHECK_FALSE(contains(page, "No trees yet."));
  CHECK(contains(page, "<footer>Windmill</footer>"));
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

  CHECK_EQ(page, fenceless);
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

  CHECK_EQ(body["count"].asUInt(), 2u);
  REQUIRE_EQ(body["entries"].size(), 2u);
  CHECK_EQ(body["entries"][0]["id"].asString(), std::string("t_popular"));
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
  CHECK_EQ(named["entries"][0]["id"].asString(), std::string("t_source"));
  CHECK_FALSE(named["entries"][0].isMember("sourceTitle"));
  CHECK_EQ(named["entries"][1]["id"].asString(), std::string("t_fork"));
  CHECK_EQ(named["entries"][1]["sourceTitle"].asString(), std::string("Learn Rust"));

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
  h.progress->setStatus(TreeId{"t_tended"}, owner, NodeId{"n0"}, ProgressStatus::complete, false, Hlc{900, 0, "sam"}, 900);

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
  CHECK_EQ(first["count"].asUInt(), 3u);
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

// A card counts what the owner's own reads count: a step that opens a tree is done when that tree is, whatever mark it
// holds, read in one follow per owner and none for an owner whose listed trees open nothing.
TEST(the_wall_counts_a_step_that_opens_a_tree_by_the_owners_derived_completion_in_one_follow_per_owner) {
  Harness h;
  const UserId ada{"ada"};
  const UserId bo{"bo"};
  const UserId cy{"cy"};
  h.seedSteps("t_ada_done", ada, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_ada_open", ada, Visibility::private_, {{"o", ""}});
  h.seedSteps("t_ada_one", ada, Visibility::public_, {{"done", "t_ada_done"}, {"open", "t_ada_open"}, {"plain", ""}});
  h.seedSteps("t_ada_two", ada, Visibility::public_, {{"done", "t_ada_done"}, {"gone", "t_ada_gone"}, {"plain", ""}});
  h.seedSteps("t_bo", bo, Visibility::public_, {{"a", ""}, {"b", ""}, {"c", ""}});
  h.seedSteps("t_cy_sub", cy, Visibility::public_, {{"x", ""}, {"y", ""}, {"z", ""}});
  h.seedSteps("t_cy", cy, Visibility::public_, {{"idea", "t_cy_sub"}, {"b", ""}, {"c", ""}});
  h.progress->setStatus(TreeId{"t_ada_done"}, ada, NodeId{"d"}, ProgressStatus::complete, false, Hlc{800, 0, "ada"}, 800);
  h.progress->setStatus(TreeId{"t_ada_one"}, ada, NodeId{"open"}, ProgressStatus::complete, false, Hlc{900, 0, "ada"}, 900);
  h.progress->setStatus(TreeId{"t_ada_one"}, ada, NodeId{"plain"}, ProgressStatus::complete, false, Hlc{901, 0, "ada"}, 901);
  h.progress->setStatus(TreeId{"t_ada_two"}, ada, NodeId{"gone"}, ProgressStatus::complete, false, Hlc{902, 0, "ada"}, 902);
  h.progress->setStatus(TreeId{"t_bo"}, bo, NodeId{"a"}, ProgressStatus::complete, false, Hlc{903, 0, "bo"}, 903);
  h.progress->setStatus(TreeId{"t_cy"}, cy, NodeId{"idea"}, ProgressStatus::complete, false, Hlc{904, 0, "cy"}, 904);

  const Json::Value index = bodyOf(sendIndex(h.api, galleryReq()));

  std::map<std::string, std::string> doneOfTotal;
  for (const Json::Value& row : index["entries"])
    doneOfTotal[row["id"].asString()] = std::to_string(row["done"].asInt()) + "/" + std::to_string(row["total"].asInt());
  CHECK(doneOfTotal == (std::map<std::string, std::string>{
                           {"t_ada_one", "2/3"}, {"t_ada_two", "2/3"}, {"t_bo", "1/3"}, {"t_cy", "0/3"}, {"t_cy_sub", "0/3"}}));
  CHECK_EQ(h.trees->openedReads,
           (std::vector<std::set<TreeId>>{{TreeId{"t_ada_done"}, TreeId{"t_ada_gone"}, TreeId{"t_ada_open"}}, {TreeId{"t_cy_sub"}}}));
  CHECK_EQ(h.trees->openedBudgets, (std::vector<std::optional<std::chrono::milliseconds>>(2, std::chrono::milliseconds{750})));
}

// One owner whose follow fails or runs out degrades that owner alone: their cards count no step that opens a tree,
// every other owner is followed as ever, and the views of the next five minutes leave them unread without trying
// again. A view that degraded anyone says so in one line of counts; one that degraded no one writes none.
TEST(a_wall_whose_follow_of_one_owner_fails_or_times_out_counts_that_owner_alone_without_the_steps_that_open_a_tree) {
  struct Logged {
    std::mutex mutex;
    std::vector<std::string> lines;
    trantor::Logger::LogLevel level = trantor::Logger::logLevel();
    Logged() {
      trantor::Logger::setLogLevel(trantor::Logger::kInfo);
      trantor::Logger::setOutputFunction(
          [this](const char* message, std::uint64_t length) {
            const std::string line(message, length);
            const std::size_t start = line.find("roadmap_");
            if (start == std::string::npos) return;
            std::lock_guard lock(mutex);
            lines.push_back(line.substr(start, line.rfind(" - ") - start));
          },
          [] {});
    }
    ~Logged() {
      trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                         [] { fflush(stdout); });
      trantor::Logger::setLogLevel(level);
    }
  } logged;
  Harness h;
  const UserId ada{"ada"};
  const UserId bo{"bo"};
  const UserId cy{"cy"};
  const UserId dee{"dee"};
  h.seedSteps("t_ada_done", ada, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_ada", ada, Visibility::public_, {{"done", "t_ada_done"}, {"marked", "t_ada_done"}, {"plain", ""}});
  h.seedSteps("t_bo", bo, Visibility::public_, {{"a", ""}, {"b", ""}, {"c", ""}});
  h.seedSteps("t_cy_done", cy, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_cy", cy, Visibility::public_, {{"done", "t_cy_done"}, {"b", ""}, {"c", ""}});
  h.seedSteps("t_dee_done", dee, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_dee", dee, Visibility::public_, {{"done", "t_dee_done"}, {"b", ""}, {"c", ""}});
  for (const auto& [owner, tree] : {std::pair{ada, "t_ada_done"}, std::pair{cy, "t_cy_done"}, std::pair{dee, "t_dee_done"}})
    h.progress->setStatus(TreeId{tree}, owner, NodeId{"d"}, ProgressStatus::complete, false, Hlc{800, 0, "seed"}, 800);
  h.progress->setStatus(TreeId{"t_ada"}, ada, NodeId{"marked"}, ProgressStatus::complete, false, Hlc{900, 0, "ada"}, 900);
  h.progress->setStatus(TreeId{"t_ada"}, ada, NodeId{"plain"}, ProgressStatus::complete, false, Hlc{901, 0, "ada"}, 901);
  h.progress->setStatus(TreeId{"t_bo"}, bo, NodeId{"a"}, ProgressStatus::complete, false, Hlc{902, 0, "bo"}, 902);
  h.trees->duringOpenedRead = [&] {
    if (h.trees->openedOwners.back() == ada) throw std::runtime_error("connection reset mid-read");
    if (h.trees->openedOwners.back() == cy) throw FollowTimedOut{};
  };
  const auto doneOnTheWall = [&] {
    const drogon::HttpResponsePtr reply = sendIndex(h.api, galleryReq());
    CHECK_EQ(reply->getStatusCode(), drogon::k200OK);
    const Json::Value index = bodyOf(reply);
    std::map<std::string, int> done;
    for (const Json::Value& row : index["entries"]) done[row["id"].asString()] = row["done"].asInt();
    return done;
  };
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });

  const std::map<std::string, int> degraded = doneOnTheWall();
  const std::vector<UserId> firstFollows = h.trees->openedOwners;
  h.trees->duringOpenedRead = {};
  const std::map<std::string, int> coolingOff = doneOnTheWall();
  const std::vector<UserId> secondFollows(h.trees->openedOwners.begin() + firstFollows.size(), h.trees->openedOwners.end());
  h.clock.now += 5 * 60 * 1000;
  const std::map<std::string, int> whole = doneOnTheWall();
  const std::vector<UserId> thirdFollows(h.trees->openedOwners.begin() + firstFollows.size() + secondFollows.size(),
                                         h.trees->openedOwners.end());
  installWriteSink({});

  CHECK(degraded == (std::map<std::string, int>{{"t_ada", 1}, {"t_bo", 1}, {"t_cy", 0}, {"t_dee", 1}}));
  CHECK(coolingOff == degraded);
  CHECK(whole == (std::map<std::string, int>{{"t_ada", 3}, {"t_bo", 1}, {"t_cy", 1}, {"t_dee", 1}}));
  CHECK_EQ(firstFollows, (std::vector<UserId>{ada, cy, dee}));
  CHECK_EQ(secondFollows, (std::vector<UserId>{dee}));
  CHECK_EQ(thirdFollows, (std::vector<UserId>{ada, cy, dee}));
  CHECK_EQ(lines, (std::vector<std::string>{"roadmap.progress.follow roadmap gallery failed",
                                            "roadmap.progress.follow roadmap gallery timeout"}));
  CHECK_EQ(logged.lines, (std::vector<std::string>{
                             "roadmap_gallery_follows followed=1 timed_out=1 failed=1 cooling_off=0 past_cap=0",
                             "roadmap_gallery_follows followed=1 timed_out=0 failed=0 cooling_off=2 past_cap=0",
                             "roadmap_progress_follow_recovered door=gallery degraded_replies=2",
                             "roadmap_progress_follow_recovered door=gallery degraded_replies=2"}));
}

// Owners are followed in the order the wall shows their cards as far as it is known before their marks are: the most
// forked first, then the most recently edited, so an account comes no earlier for the id it holds.
TEST(the_wall_follows_its_owners_in_the_order_it_shows_their_cards_and_never_by_their_ids) {
  Harness h;
  const UserId aaron{"aaron"};
  const UserId mia{"mia"};
  const UserId zoe{"zoe"};
  for (const UserId& owner : {aaron, mia, zoe}) {
    const std::string sub = "t_sub_" + owner.str();
    const std::string main = "t_main_" + owner.str();
    h.seedSteps(sub.c_str(), owner, Visibility::private_, {{"d", ""}});
    h.seedSteps(main.c_str(), owner, Visibility::public_, {{"done", sub.c_str()}, {"b", ""}, {"c", ""}});
  }
  h.trees->updatedAt["t_main_aaron"] = 100;
  h.trees->updatedAt["t_main_mia"] = 300;
  h.trees->updatedAt["t_main_zoe"] = 200;
  h.seedSteps("t_fork_of_zoe", UserId{"bystander"}, Visibility::private_, {{"x", ""}});
  h.seedFork("t_fork_of_zoe", "t_main_zoe");

  const Json::Value index = bodyOf(sendIndex(h.api, galleryReq()));

  CHECK_EQ(index["entries"][0]["id"].asString(), std::string("t_main_zoe"));
  CHECK_EQ(index["entries"][1]["id"].asString(), std::string("t_main_mia"));
  CHECK_EQ(index["entries"][2]["id"].asString(), std::string("t_main_aaron"));
  CHECK_EQ(h.trees->openedOwners, (std::vector<UserId>{zoe, mia, aaron}));
}

// A card's time and place on the wall come from what a reader is shown of the owner's marks and nothing else: two
// trees whose readers are shown the same rows have the same time on the JSON index and stand by id alone on both
// walls, though one of them holds a later mark no reader is shown.
TEST(two_trees_shown_alike_to_readers_wear_the_same_time_and_place_on_both_walls_whatever_marks_lie_behind_them) {
  Harness h;
  const UserId ada{"ada"};
  h.seedSteps("t_done", ada, Visibility::private_, {{"d", ""}});
  h.seedSteps("t_open", ada, Visibility::private_, {{"o", ""}});
  h.seedSteps("t_b_pointers", ada, Visibility::public_, {{"via", "t_done"}, {"wait", "t_open"}, {"plain", ""}});
  h.seedSteps("t_a_twin", ada, Visibility::public_, {{"via", ""}, {"wait", ""}, {"plain", ""}});
  h.trees->byId["t_b_pointers"].title.value = "Same";
  h.trees->byId["t_a_twin"].title.value = "Same";
  h.progress->setStatus(TreeId{"t_done"}, ada, NodeId{"d"}, ProgressStatus::complete, false, Hlc{800, 0, "ada"}, 800);
  h.progress->setStatus(TreeId{"t_b_pointers"}, ada, NodeId{"plain"}, ProgressStatus::complete, false, Hlc{700, 0, "ada"}, 700);
  h.progress->setStatus(TreeId{"t_b_pointers"}, ada, NodeId{"wait"}, ProgressStatus::complete, false, Hlc{990, 0, "ada"}, 990);
  h.progress->setStatus(TreeId{"t_a_twin"}, ada, NodeId{"plain"}, ProgressStatus::complete, false, Hlc{700, 0, "ada"}, 700);
  h.progress->setStatus(TreeId{"t_a_twin"}, ada, NodeId{"via"}, ProgressStatus::complete, false, Hlc{800, 0, "ada"}, 800);

  Json::Value index = bodyOf(sendIndex(h.api, galleryReq()));
  drogon::HttpResponsePtr page;
  h.api.page(galleryReq(), [&](const drogon::HttpResponsePtr& response) { page = response; });

  REQUIRE_EQ(index["entries"].size(), 2u);
  CHECK_EQ(index["entries"][0]["id"].asString(), std::string("t_a_twin"));
  CHECK_EQ(index["entries"][1]["id"].asString(), std::string("t_b_pointers"));
  for (Json::Value& row : index["entries"]) row.removeMember("id");
  CHECK_EQ(index["entries"][0], index["entries"][1]);
  CHECK_EQ(index["entries"][0]["updatedAt"].asInt64(), Json::Int64{800});
  const std::string html(page->getBody());
  const auto card = [&](const std::string& id) -> std::pair<std::size_t, std::string> {
    const std::size_t from = html.find("<a class=\"card\" href=\"/t/" + id + "\">");
    if (from == std::string::npos) return {from, "no card"};
    std::string text = html.substr(from, html.find("</a>", from) - from);
    for (std::size_t at = text.find(id); at != std::string::npos; at = text.find(id)) text.replace(at, id.size(), "ID");
    return std::pair{from, text};
  };
  const auto [twinAt, twin] = card("t_a_twin");
  const auto [pointersAt, pointers] = card("t_b_pointers");
  CHECK(pointersAt != std::string::npos);
  CHECK(twinAt < pointersAt);
  CHECK_EQ(twin, pointers);
}
