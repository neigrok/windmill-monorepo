#include "products/journal/domain/SpanReconcile.h"

#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;

namespace {

Passage at(int ord, std::string text) {
  return Passage{ord, 0, static_cast<int>(text.size()), std::move(text)};
}

std::vector<Passage> page(std::vector<std::string> lines) {
  std::vector<Passage> passages;
  for (std::size_t i = 0; i < lines.size(); ++i) passages.push_back(at(static_cast<int>(i), lines[i]));
  return passages;
}

}

TEST(an_unchanged_page_keeps_every_identity) {
  const std::vector<KnownSpan> stored{{11, "i want to learn c++."}, {12, "rain all evening."}};
  const std::vector<IdentifiedPassage> carried =
      reconcile(stored, page({"i want to learn c++.", "rain all evening."}));

  REQUIRE_EQ(carried.size(), std::size_t{2});
  CHECK_EQ(carried[0].spanId, std::int64_t{11});
  CHECK_EQ(carried[1].spanId, std::int64_t{12});
}

TEST(a_sentence_inserted_at_the_top_shifts_no_identity) {
  const std::vector<KnownSpan> stored{{11, "i want to learn c++."}, {12, "rain all evening."}};
  const std::vector<IdentifiedPassage> carried =
      reconcile(stored, page({"slept badly.", "i want to learn c++.", "rain all evening."}));

  REQUIRE_EQ(carried.size(), std::size_t{3});
  CHECK_EQ(carried[0].spanId, std::int64_t{0});      // the new line mints
  CHECK_EQ(carried[1].spanId, std::int64_t{11});     // and the old ones are untouched
  CHECK_EQ(carried[2].spanId, std::int64_t{12});
  CHECK_EQ(carried[1].passage.ord, 1);               // even though their ordinals moved
  CHECK_EQ(carried[2].passage.ord, 2);
}

TEST(a_deleted_line_leaves_the_survivors_alone) {
  const std::vector<KnownSpan> stored{
      {11, "slept badly."}, {12, "i want to learn c++."}, {13, "rain all evening."}};
  const std::vector<IdentifiedPassage> carried =
      reconcile(stored, page({"slept badly.", "rain all evening."}));

  REQUIRE_EQ(carried.size(), std::size_t{2});
  CHECK_EQ(carried[0].spanId, std::int64_t{11});
  CHECK_EQ(carried[1].spanId, std::int64_t{13});
}

TEST(edited_text_mints_and_does_not_inherit_a_neighbours_identity) {
  const std::vector<KnownSpan> stored{{11, "i want to lern c++."}, {12, "rain all evening."}};
  const std::vector<IdentifiedPassage> carried =
      reconcile(stored, page({"i want to learn c++.", "rain all evening."}));

  CHECK_EQ(carried[0].spanId, std::int64_t{0});      // the typo fix is new text
  CHECK_EQ(carried[1].spanId, std::int64_t{12});
}

TEST(reflowed_whitespace_is_the_same_passage) {
  const std::vector<KnownSpan> stored{{11, "i want to learn c++."}};
  const std::vector<IdentifiedPassage> carried =
      reconcile(stored, page({"  i want   to learn c++.  "}));

  REQUIRE_EQ(carried.size(), std::size_t{1});
  CHECK_EQ(carried[0].spanId, std::int64_t{11});
}

TEST(two_identical_lines_keep_two_distinct_identities_in_document_order) {
  const std::vector<KnownSpan> stored{{11, "tired."}, {12, "rain."}, {13, "tired."}};
  const std::vector<IdentifiedPassage> carried = reconcile(stored, page({"tired.", "rain.", "tired."}));

  CHECK_EQ(carried[0].spanId, std::int64_t{11});
  CHECK_EQ(carried[1].spanId, std::int64_t{12});
  CHECK_EQ(carried[2].spanId, std::int64_t{13});
}

TEST(a_third_copy_of_a_duplicated_line_mints_rather_than_stealing) {
  const std::vector<KnownSpan> stored{{11, "tired."}, {12, "tired."}};
  const std::vector<IdentifiedPassage> carried = reconcile(stored, page({"tired.", "tired.", "tired."}));

  CHECK_EQ(carried[0].spanId, std::int64_t{11});
  CHECK_EQ(carried[1].spanId, std::int64_t{12});
  CHECK_EQ(carried[2].spanId, std::int64_t{0});
}

TEST(a_first_derivation_mints_everything) {
  const std::vector<IdentifiedPassage> carried = reconcile({}, page({"slept badly.", "rain."}));

  REQUIRE_EQ(carried.size(), std::size_t{2});
  CHECK_EQ(carried[0].spanId, std::int64_t{0});
  CHECK_EQ(carried[1].spanId, std::int64_t{0});
}

TEST(an_emptied_page_carries_nothing) {
  const std::vector<KnownSpan> stored{{11, "slept badly."}};
  CHECK_EQ(reconcile(stored, {}).size(), std::size_t{0});
}

TEST(reconciling_twice_is_stable) {
  const std::vector<KnownSpan> stored{{11, "tired."}, {12, "tired."}, {13, "rain."}};
  const std::vector<Passage> fresh = page({"tired.", "rain.", "tired."});

  const std::vector<IdentifiedPassage> once = reconcile(stored, fresh);
  const std::vector<IdentifiedPassage> twice = reconcile(stored, fresh);

  REQUIRE_EQ(once.size(), twice.size());
  for (std::size_t i = 0; i < once.size(); ++i) CHECK_EQ(once[i].spanId, twice[i].spanId);
}
