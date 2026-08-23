#include "products/roadmap/domain/Tree.h"
#include "test/testing.h"

#include <string>

using namespace wm;

// The colour vocabulary: the wire name a document is stored under, and the hex the server-rendered surfaces paint with.

TEST(a_colour_name_survives_the_round_trip_through_the_wire) {
  CHECK_EQ(std::string(toString(NodeColor::terracotta)), std::string("terracotta"));
  CHECK_EQ(std::string(toString(NodeColor::olive)), std::string("olive"));
  CHECK_EQ(std::string(toString(NodeColor::gold)), std::string("gold"));
  CHECK_EQ(std::string(toString(NodeColor::brick)), std::string("brick"));
  CHECK_EQ(std::string(toString(NodeColor::sky)), std::string("sky"));
  CHECK_EQ(std::string(toString(NodeColor::plum)), std::string("plum"));

  CHECK(parseColor(toString(NodeColor::terracotta)) == std::optional<NodeColor>(NodeColor::terracotta));
  CHECK(parseColor(toString(NodeColor::plum)) == std::optional<NodeColor>(NodeColor::plum));
  CHECK(parseColor("chartreuse") == std::nullopt);
  CHECK(parseColor("") == std::nullopt);
}

TEST(every_hue_renders_to_one_fixed_hex_for_every_server_rendered_surface) {
  // In a mail the hex lands inside style="background:…", where the house's angle-bracket stripping would not protect a value that came from a person.
  CHECK_EQ(std::string(nodeColorHex(NodeColor::terracotta)), std::string("#BC6C42"));
  CHECK_EQ(std::string(nodeColorHex(NodeColor::olive)), std::string("#7D8C43"));
  CHECK_EQ(std::string(nodeColorHex(NodeColor::gold)), std::string("#C4972F"));
  CHECK_EQ(std::string(nodeColorHex(NodeColor::brick)), std::string("#A84E35"));
  CHECK_EQ(std::string(nodeColorHex(NodeColor::sky)), std::string("#5F8494"));
  CHECK_EQ(std::string(nodeColorHex(NodeColor::plum)), std::string("#8D4F83"));
}
