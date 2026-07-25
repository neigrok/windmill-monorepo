#include "adapters/http/GalleryApi.h"

#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;

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
