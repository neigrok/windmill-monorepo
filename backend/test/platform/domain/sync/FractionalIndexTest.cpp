#include "platform/domain/sync/FractionalIndex.h"

#include "test/testing.h"

#include <cstdint>
#include <optional>
#include <random>
#include <string>
#include <vector>

using namespace wm::sync;

// §11.2.5: between(a, b) lies strictly between a and b. Single keys and drops are pinned by
// sync_corpus/fracindex/*.

namespace {

void checkStrictlyBetween(const std::optional<std::string>& a, const std::optional<std::string>& b) {
  const std::string key = between(a, b);
  CHECK(isOrderKey(key));
  if (a) CHECK(*a < key);
  if (b) CHECK(key < *b);
}

std::string randomKey(std::mt19937_64& random) {
  static const std::string kDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  static const std::string kHeads = "UVWXYZabcdef";   // integer parts of 2 to 7 characters
  auto digit = [&random] { return kDigits[random() % kDigits.size()]; };
  const char head = kHeads[random() % kHeads.size()];
  const std::size_t integerDigits = head >= 'a' ? static_cast<std::size_t>(head - 'a' + 1) : static_cast<std::size_t>('Z' - head + 1);
  std::string key(1, head);
  for (std::size_t i = 0; i < integerDigits; ++i) key.push_back(digit());
  const std::size_t fractionDigits = random() % 4;
  for (std::size_t i = 0; i < fractionDigits; ++i) key.push_back(i + 1 == fractionDigits ? kDigits[1 + random() % 61] : digit());
  return key;
}

}

TEST(between_lies_strictly_between_the_neighbours_of_a_growing_list) {
  std::mt19937_64 random(25);
  for (int run = 0; run < 20; ++run) {
    std::vector<std::string> list;
    for (int insert = 0; insert < 400; ++insert) {
      const std::size_t gap = random() % (list.size() + 1);
      const std::optional<std::string> a = gap == 0 ? std::nullopt : std::optional(list[gap - 1]);
      const std::optional<std::string> b = gap == list.size() ? std::nullopt : std::optional(list[gap]);
      checkStrictlyBetween(a, b);
      list.insert(list.begin() + static_cast<std::ptrdiff_t>(gap), between(a, b));
    }
  }
}

TEST(between_lies_strictly_between_any_two_keys) {
  std::mt19937_64 random(52);
  for (int round = 0; round < 20000; ++round) {
    std::string a = randomKey(random);
    std::string b = randomKey(random);
    if (a == b) continue;
    if (b < a) std::swap(a, b);
    checkStrictlyBetween(a, b);
    checkStrictlyBetween(std::nullopt, b);
    checkStrictlyBetween(a, std::nullopt);
  }
}

TEST(appending_and_prepending_cross_integer_heads_in_order) {
  std::string last = between(std::nullopt, std::nullopt);
  std::string first = last;
  for (int step = 0; step < 5000; ++step) {
    const std::string after = between(last, std::nullopt);
    const std::string before = between(std::nullopt, first);
    REQUIRE(isOrderKey(after) && last < after);
    REQUIRE(isOrderKey(before) && before < first);
    last = after;
    first = before;
  }
  CHECK_EQ(last.front(), 'c');    // "az" rolls to "b00", and "bzz" to "c000"
  CHECK_EQ(first.front(), 'X');   // "Z0" rolls down to "Yzz", and "Y00" to "Xzzz"
}
