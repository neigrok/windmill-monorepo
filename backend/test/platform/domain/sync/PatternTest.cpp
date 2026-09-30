#include "platform/domain/sync/Pattern.h"

#include "test/testing.h"

#include <json/json.h>

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

using namespace wm::sync;

namespace {

bool refused(const std::string& source) {
  try {
    Pattern{source};
    return false;
  } catch (const std::invalid_argument&) {
    return true;
  }
}

// A random portable pattern, written beside the tree it spells so an oracle can match it by the plain meaning of
// each part: groups nested three deep, alternatives, byte classes, and every quantifier, groups that match the
// empty value included.
class PatternGenerator {
public:
  static constexpr int kUnbounded = -1;

  // An atom (a byte class, or a group of alternative sequences) taken from `min` to `max` times.
  struct Node {
    std::string bytes;
    std::vector<std::vector<Node>> branches;
    int min = 1;
    int max = 1;
  };
  using Sequence = std::vector<Node>;

  explicit PatternGenerator(std::uint64_t seed) : random_(seed) {}

  std::pair<std::string, Sequence> pattern() {
    std::string text;
    Sequence tree = sequence(0, text);
    return {"^" + text + "$", std::move(tree)};
  }

  // A value the pattern holds, a mutation of one, or random bytes.
  std::string value(const Sequence& tree) {
    const int kind = pick(0, 2);
    if (kind == 0) return randomBytes();
    std::string held = sample(tree).substr(0, 16);
    if (kind == 1 || held.empty()) return held;
    const auto at = static_cast<std::size_t>(pick(0, static_cast<int>(held.size()) - 1));
    if (pick(0, 1) == 0) return held.erase(at, 1);
    held[at] = "ab.-]"[pick(0, 4)];
    return held;
  }

private:
  int pick(int low, int high) { return std::uniform_int_distribution<int>(low, high)(random_); }

  std::string randomBytes() {
    std::string text;
    const int length = pick(0, 8);
    for (int i = 0; i < length; ++i) text.push_back("ab.-]\n"[pick(0, 5)]);
    return text;
  }

  Node atom(int depth, std::string& text) {
    static const std::vector<std::pair<std::string, std::string>> classes{
        {"a", "a"}, {"b", "b"}, {"\\.", "."}, {"-", "-"}, {"[ab]", "ab"}, {"[a-b]", "ab"}, {"[\\.a]", ".a"}, {"[-a]", "-a"}, {"[b-]", "b-"}, {"[\\]\\-]", "]-"}};
    if (depth >= 3 || pick(0, 9) < 7) {
      const auto& [spelled, bytes] = classes[static_cast<std::size_t>(pick(0, 9))];
      text += spelled;
      return Node{.bytes = bytes};
    }
    text += pick(0, 1) == 0 ? "(?:" : "(";
    Node group;
    const int branches = pick(1, 3);
    for (int i = 0; i < branches; ++i) {
      if (i > 0) text += "|";
      group.branches.push_back(sequence(depth + 1, text));
    }
    text += ")";
    return group;
  }

  Sequence sequence(int depth, std::string& text) {
    static const std::vector<std::tuple<std::string, int, int>> quantifiers{
        {"", 1, 1}, {"?", 0, 1}, {"*", 0, kUnbounded}, {"+", 1, kUnbounded}, {"{2}", 2, 2}, {"{0,2}", 0, 2}, {"{1,3}", 1, 3}, {"{2,}", 2, kUnbounded}, {"{0}", 0, 0}};
    Sequence items;
    const int count = pick(0, 4);
    for (int i = 0; i < count; ++i) {
      Node node = atom(depth, text);
      const auto& [spelled, min, max] = quantifiers[static_cast<std::size_t>(pick(0, 8))];
      text += spelled;
      node.min = min;
      node.max = max;
      items.push_back(std::move(node));
    }
    return items;
  }

  std::string sample(const Sequence& tree) {
    std::string held;
    for (const Node& node : tree) {
      const int times = pick(node.min, node.max == kUnbounded ? node.min + 2 : node.max);
      for (int k = 0; k < times; ++k) {
        if (node.branches.empty()) held.push_back(node.bytes[static_cast<std::size_t>(pick(0, static_cast<int>(node.bytes.size()) - 1))]);
        else held += sample(node.branches[static_cast<std::size_t>(pick(0, static_cast<int>(node.branches.size()) - 1))]);
      }
    }
    return held;
  }

  std::mt19937_64 random_;
};

// The plain meaning of a generated tree: the positions of `value` each part can end at, from where it starts.
class EndPositions {
public:
  using Node = PatternGenerator::Node;
  using Sequence = PatternGenerator::Sequence;

  explicit EndPositions(std::string value) : value_(std::move(value)) {}

  bool matchesWhole(const Sequence& tree) { return ofSequence(tree, 0).contains(value_.size()); }

private:
  std::set<std::size_t> ofSequence(const Sequence& sequence, std::size_t start) {
    std::set<std::size_t> ends{start};
    for (const Node& node : sequence) {
      std::set<std::size_t> next;
      for (const std::size_t at : ends) {
        const std::set<std::size_t> reached = ofNode(node, at);
        next.insert(reached.begin(), reached.end());
      }
      ends = std::move(next);
    }
    return ends;
  }

  std::set<std::size_t> ofNode(const Node& node, std::size_t start) {
    const auto known = memo_.find({&node, start});
    if (known != memo_.end()) return known->second;
    std::set<std::size_t> ends;
    if (node.min == 0) ends.insert(start);
    std::set<std::size_t> reached{start};
    const int most = node.max == PatternGenerator::kUnbounded ? node.min + static_cast<int>(value_.size()) + 1 : node.max;
    for (int times = 1; times <= most && !reached.empty(); ++times) {
      std::set<std::size_t> next;
      for (const std::size_t at : reached) {
        const std::set<std::size_t> after = ofAtom(node, at);
        next.insert(after.begin(), after.end());
      }
      reached = std::move(next);
      if (times >= node.min) ends.insert(reached.begin(), reached.end());
    }
    return memo_[{&node, start}] = ends;
  }

  std::set<std::size_t> ofAtom(const Node& node, std::size_t start) {
    if (node.branches.empty()) {
      if (start < value_.size() && node.bytes.find(value_[start]) != std::string::npos) return {start + 1};
      return {};
    }
    std::set<std::size_t> ends;
    for (const Sequence& branch : node.branches) {
      const std::set<std::size_t> reached = ofSequence(branch, start);
      ends.insert(reached.begin(), reached.end());
    }
    return ends;
  }

  std::string value_;
  std::map<std::pair<const Node*, std::size_t>, std::set<std::size_t>> memo_;
};

}

// The reference's table (core/registry.js isPortablePattern), its portable patterns and the rest.
TEST(a_portable_pattern_is_the_subset_every_dialect_reads_alike_repeat_counts_at_most_65535) {
  const std::vector<std::string> portable{"^b_[0-9a-f]{8}$", "^[A-Za-z0-9_-]{8,64}$", "^[-a]$", "^(?:ab|cd)+$", "^(a|b)?c{2,}$", "^a\\.b\\/c$",
                                          "^[\\]\\-]$", "^a{65535}$", "^a{1,65535}$", "^[a:]$"};
  const std::vector<std::string> outside{"b_[0-9a-f]{8}$", "^b_[0-9a-f]{8}", "^a|b$", "^.{1,64}$", "^\\s+$", "^\\d+$", "^\\w+$", "^a\\b$",
                                         "^\\_$", "^[^/]+$", "^[]$", "^[z-a]$", "^[a-b-c]$", "^[a--]$", "^[a&&b]$", "^[[a]]$", "^a+?$",
                                         "^a**$", "^a{3,2}$", "^a{,2}$", "^(?=a)a$", "^(a)\\1$", "^a$b$", "^\xc3\xa9$", "^a\\$",
                                         "^a{65536}$", "^a{2,65536}$", "^[:a]$", "^[\\--a]$"};
  for (const std::string& source : portable) {
    CHECK(Pattern::isPortable(source));
    CHECK_FALSE(refused(source));
  }
  for (const std::string& source : outside) {
    CHECK_FALSE(Pattern::isPortable(source));
    CHECK(refused(source));
  }
}

TEST(a_pattern_matches_the_whole_value_as_every_dialect_does) {
  const Pattern lower{"^[a-z]+$"};
  CHECK(lower.matches("abc"));
  CHECK_FALSE(lower.matches("abc\n"));
  CHECK_FALSE(lower.matches("xabcx!"));
  CHECK_FALSE(lower.matches(""));
  CHECK_FALSE(lower.matches("ab\xc3\xa9"));
  const Pattern escaped{"^[\\]\\-]$"};
  CHECK(escaped.matches("]"));
  CHECK(escaped.matches("-"));
  CHECK_FALSE(escaped.matches("\\"));
  const Pattern grouped{"^(?:ab|cd)+/$"};
  CHECK(grouped.matches("abcdab/"));
  CHECK_FALSE(grouped.matches("abc/"));
  const Pattern empty{"^$"};
  CHECK(empty.matches(""));
  CHECK_FALSE(empty.matches("a"));
  const Pattern never{"^a{0}b$"};
  CHECK(never.matches("b"));
  CHECK_FALSE(never.matches("ab"));
}

TEST(a_pattern_counts_to_65535_with_every_count_a_number_never_an_unrolled_automaton) {
  const Pattern bounded{"^a{1,65535}$"};
  CHECK(bounded.matches(std::string(65'535, 'a')));
  CHECK_FALSE(bounded.matches(std::string(65'536, 'a')));
  CHECK_FALSE(bounded.matches(""));
  const Pattern pairs{"^(?:ab){65535}$"};
  std::string ab;
  for (int i = 0; i < 65'535; ++i) ab += "ab";
  CHECK(pairs.matches(ab));
  CHECK_FALSE(pairs.matches(ab.substr(2)));
  const Pattern optional{"^(?:a?){65535}$"};
  CHECK(optional.matches(std::string(65'535, 'a')));
  CHECK_FALSE(optional.matches(std::string(65'536, 'a')));
}

// Two counted items that read the same bytes split a value many ways; each split is covered by the widest, so the
// match stays linear in the value.
TEST(a_pattern_whose_counts_can_split_a_value_many_ways_matches_in_one_pass) {
  const Pattern split{"^a{0,65535}a{0,65535}$"};
  CHECK(split.matches(std::string(131'070, 'a')));
  CHECK_FALSE(split.matches(std::string(131'071, 'a')));
  const Pattern nested{"^(?:a{0,65535}){0,65535}$"};
  CHECK(nested.matches(std::string(200'000, 'a')));
  CHECK_FALSE(nested.matches(std::string(200'000, 'a') + "b"));
}

// The match keeps no stack per byte: a million bytes read on a thread with the platform's default stack, which
// macOS sizes at 512 KiB.
TEST(a_pattern_matches_a_million_bytes_on_a_default_thread_stack) {
  bool matched = false;
  bool refusedOne = true;
  std::thread reader([&matched, &refusedOne] {
    const Pattern slug{"^[a-z][a-z0-9]*$"};
    const std::string value(1'000'000, 'a');
    matched = slug.matches(value);
    refusedOne = slug.matches(value + "-");
  });
  reader.join();
  CHECK(matched);
  CHECK_FALSE(refusedOne);
}

TEST(a_pattern_answers_as_the_plain_meaning_of_its_parts_on_every_generated_pattern_and_value) {
  PatternGenerator generator(20260927);
  int compared = 0;
  int held = 0;
  for (int i = 0; i < 1500; ++i) {
    const auto [source, tree] = generator.pattern();
    const Pattern pattern{source};
    for (int k = 0; k < 40; ++k) {
      const std::string value = generator.value(tree);
      const bool expected = EndPositions(value).matchesWhole(tree);
      if (pattern.matches(value) != expected) {
        CHECK_EQ(source + " on " + value, std::string("an agreement"));
        return;
      }
      ++compared;
      held += expected ? 1 : 0;
    }
  }
  CHECK_EQ(compared, 60'000);
  CHECK(held > 20'000);
}

// The JS reference's verdicts (core/registry.js isPortablePattern, core/values.js checkDomain) on every case in WM_PATTERN_CASES.
TEST(a_pattern_answers_as_the_js_reference_does_on_every_case_it_generated) {
  const char* path = std::getenv("WM_PATTERN_CASES");
  if (path == nullptr) SKIP("WM_PATTERN_CASES names no file: write one with node backend/test/platform/domain/sync/reference_pattern_cases.mjs");
  std::ifstream file{path};
  REQUIRE(file.is_open());
  Json::Value generated;
  std::string errors;
  REQUIRE(Json::parseFromStream(Json::CharReaderBuilder{}, file, &generated, &errors));
  Json::StreamWriterBuilder escaper;
  escaper["indentation"] = "";
  const auto quoted = [&escaper](const std::string& text) { return Json::writeString(escaper, Json::Value{text}); };
  const auto verdict = [](bool yes) { return std::string(yes ? "true" : "false"); };
  const std::string seed = generated["seed"].asString();
  int disagreements = 0;
  const auto disagree = [&disagreements, &seed](const std::string& what) {
    if (++disagreements <= 20) std::cerr << "  seed " << seed << ": " << what << "\n";
  };
  int patterns = 0;
  int portable = 0;
  int pairs = 0;
  int matching = 0;
  for (const Json::Value& generatedCase : generated["cases"]) {
    const std::string source = generatedCase["pattern"].asString();
    const bool referencePortable = generatedCase["portable"].asBool();
    ++patterns;
    if (Pattern::isPortable(source) != referencePortable) {
      disagree("Pattern::isPortable(" + quoted(source) + ") is " + verdict(!referencePortable) + ", the reference says " + verdict(referencePortable));
      continue;
    }
    if (!referencePortable) continue;
    ++portable;
    const Pattern pattern{source};
    for (const Json::Value& checked : generatedCase["values"]) {
      const std::string value = checked["value"].asString();
      const bool referenceMatches = checked["matches"].asBool();
      ++pairs;
      matching += referenceMatches ? 1 : 0;
      if (pattern.matches(value) != referenceMatches) {
        disagree("Pattern{" + quoted(source) + "}.matches(" + quoted(value) + ") is " + verdict(!referenceMatches) + ", the reference says " + verdict(referenceMatches));
      }
    }
  }
  CHECK_EQ(disagreements, 0);
  CHECK(patterns >= 1000);
  CHECK(portable >= 500 && patterns - portable >= 500);
  CHECK(pairs >= 10'000);
  CHECK(matching >= 2'000 && pairs - matching >= 2'000);
}
