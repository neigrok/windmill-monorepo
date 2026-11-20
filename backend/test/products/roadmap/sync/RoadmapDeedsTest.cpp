#include "products/roadmap/sync/RoadmapDeeds.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/domain/sync/Jcs.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "test/testing.h"

#include <string>
#include <vector>

// What one intent's records tell a roadmap's activity (roadmap-on-the-engine.md §7): the deed a reader reads, in the
// command words the feed already speaks, judged on the records as the intent found them and leaves them.

using namespace wm;
using namespace wm::roadmap::engine;

namespace {

sync::Row row(const std::string& wire) { return sync::Row(parse(wire)); }

std::string told(const std::optional<Command>& deed) {
  if (!deed) return "no deed";
  return commandKind(*deed) + " " + sync::jcs(commandPayload(*deed));
}

const char* kBasics = R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 1,
    "f": {"label": ["Basics", "1:0:r_a"], "color": ["olive", "1:0:r_a"], "ord": ["a0", "1:0:r_a"]}})";
const char* kOwnership = R"({"t": "node", "id": "ownership", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 1,
    "f": {"label": ["Ownership", "1:0:r_a"], "ord": ["a1", "1:0:r_a"]}})";

}

TEST(a_step_made_with_its_links_is_one_deed_that_names_it) {
  const std::vector<Touched> records{
      {std::nullopt, row(kBasics)},
      {std::nullopt, row(R"({"t": "edge", "id": ["ownership", "basics"], "life": ["alive", "2:0:r_a"], "seq": 2})")},
      {std::nullopt, row(R"({"t": "edge", "id": ["basics", "deep"], "life": ["alive", "2:0:r_a"], "seq": 2})")},
  };
  CHECK_EQ(told(deedOf(records)), told(CreateNode{NodeId{"basics"}, "Basics", "", NodeColor::olive, {}, "", {}}));
}

TEST(a_roadmap_born_with_its_kinds_and_steps_tells_the_steps_alone) {
  const std::vector<Touched> records{
      {std::nullopt, row(R"({"t": "meta", "id": "meta", "seq": 1, "f": {"title": ["A roadmap", "1:0:r_a"]}})")},
      {std::nullopt, row(R"({"t": "kind", "id": "build", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 1,
          "f": {"hue": ["terracotta", "1:0:r_a"], "label": ["Build", "1:0:r_a"]}})")},
      {std::nullopt, row(kBasics)},
      {std::nullopt, row(kOwnership)},
      {std::nullopt, row(R"({"t": "edge", "id": ["basics", "ownership"], "life": ["alive", "1:0:r_a"], "seq": 1})")},
  };
  CHECK_EQ(told(deedOf(records)),
           told(Batch{{CreateNode{NodeId{"basics"}, "Basics", "", NodeColor::olive, {}, "", {}},
                       CreateNode{NodeId{"ownership"}, "Ownership", "", NodeColor::terracotta, {}, "", {}}}}));
}

TEST(a_kind_recoloured_with_the_steps_it_repaints_is_the_recolour_alone) {
  const std::vector<Touched> records{
      {row(R"({"t": "kind", "id": "learn", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 1, "f": {"hue": ["olive", "1:0:r_a"]}})"),
       row(R"({"t": "kind", "id": "learn", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 3, "f": {"hue": ["sky", "3:0:srv"]}})")},
      {row(kBasics), row(R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["alive", "1:0:r_a"], "seq": 3,
          "f": {"label": ["Basics", "1:0:r_a"], "color": ["sky", "3:0:srv"], "ord": ["a0", "1:0:r_a"]}})")},
  };
  CHECK_EQ(told(deedOf(records)), told(RecolorKind{KindId{"learn"}, NodeColor::sky}));
}

TEST(a_step_renamed_and_recoloured_and_a_link_drawn_between_two_steps_are_told_in_the_feeds_order) {
  const std::vector<Touched> records{
      {std::nullopt, row(R"({"t": "edge", "id": ["basics", "ownership"], "life": ["alive", "4:0:r_a"], "seq": 4})")},
      {row(kBasics), row(R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["alive", "4:0:r_a"], "seq": 4,
          "f": {"label": ["Foundations", "4:0:r_a"], "color": ["plum", "4:0:r_a"], "ord": ["a0", "1:0:r_a"]}})")},
      {row(kOwnership), row(kOwnership)},
  };
  CHECK_EQ(told(deedOf(records)), told(Batch{{RenameNode{NodeId{"basics"}, "Foundations"}, SetNodeColor{NodeId{"basics"}, NodeColor::plum},
                                              AddEdge{NodeId{"basics"}, NodeId{"ownership"}}}}));
}

TEST(a_step_that_comes_back_is_told_as_one_that_came_and_one_deleted_as_one_that_went) {
  const char* dead = R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["dead", "2:0:r_b"], "seq": 2,
      "f": {"label": ["Basics", "1:0:r_a"], "color": ["olive", "1:0:r_a"], "ord": ["a0", "1:0:r_a"]}})";
  const char* revived = R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["alive", "3:0:r_a"], "seq": 3,
      "f": {"label": ["Basic skills", "3:0:r_a"], "color": ["olive", "1:0:r_a"], "ord": ["a0", "1:0:r_a"]}})";
  CHECK_EQ(told(deedOf({{row(dead), row(revived)}})), told(CreateNode{NodeId{"basics"}, "Basic skills", "", NodeColor::olive, {}, "", {}}));
  CHECK_EQ(told(deedOf({{row(kBasics), row(dead)}})), told(DeleteNode{NodeId{"basics"}}));
}

TEST(an_annotation_a_move_a_title_and_what_only_the_server_writes_leave_no_deed) {
  const std::vector<Touched> records{
      {row(kBasics), row(R"({"t": "node", "id": "basics", "born": "1:0:r_a", "life": ["alive", "5:0:r_a"], "seq": 5,
          "f": {"label": ["Basics", "1:0:r_a"], "color": ["olive", "1:0:r_a"], "ord": ["a5", "5:0:r_a"], "description": ["Read the book", "5:0:r_a"],
                "branch": ["t_00000000000000e2", "5:0:srv"]}})")},
      {row(R"({"t": "meta", "id": "meta", "seq": 1, "f": {"title": ["A roadmap", "1:0:r_a"], "reach": ["private", "1:0:srv"]}})"),
       row(R"({"t": "meta", "id": "meta", "seq": 5, "f": {"title": ["Rust", "5:0:r_a"], "reach": ["public", "5:0:srv"]}})")},
  };
  CHECK_EQ(told(deedOf(records)), "no deed");
}
