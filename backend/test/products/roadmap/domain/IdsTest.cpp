#include "products/roadmap/domain/Ids.h"

#include "test/testing.h"

#include <stdexcept>

using namespace wm;

TEST(a_roadmap_stamp_reads_empty_text_and_the_unset_stamp_as_never_written) {
  CHECK_EQ(roadmapStamp(""), Hlc{});
  CHECK_EQ(roadmapStamp("0:0:"), Hlc{});
  CHECK_EQ(roadmapStamp("1700000000000:3:r_8f31c2"), (Hlc{1700000000000, 3, "r_8f31c2"}));
}

TEST(a_roadmap_stamp_refuses_text_that_is_not_a_stamp) {
  for (const char* text : {"x:0:dev", "01:0:a", "5:0:", "1:0"}) {
    bool threw = false;
    try {
      roadmapStamp(text);
    } catch (const std::invalid_argument&) {
      threw = true;
    }
    CHECK(threw);
  }
}
