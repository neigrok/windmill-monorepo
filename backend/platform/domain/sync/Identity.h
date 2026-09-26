#pragma once

#include "platform/domain/sync/Registry.h"

#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>

namespace wm::sync {

// D-26: a derived id from a label. Every UTF-8 byte outside [A-Za-z0-9] separates words, words join
// lowercased with one '-', the base stops at 40 characters before a trailing '-' drops, an empty base
// takes `fallback`, and a taken id takes the first free suffix -2, -3, ... on the base.
std::string deriveId(std::string_view label, std::string_view fallback, const std::set<std::string>& taken);

// D-8: a seeded id `<seed>-<n>`, as unique and unpredictable as its seed.
struct SeededId {
  std::string seed;
  std::int64_t n = 0;

  // The seeded id of a type that seeds: a seed the type's pattern admits of at most seedMax
  // characters, an n in 1..ordinalMax, and an id the pattern admits. Throws std::invalid_argument.
  static SeededId of(const TypeDef& type, std::string seed, std::int64_t n);

  // Split at the last '-': a non-empty seed and a decimal ordinal of at least 1 with no leading zero.
  static std::optional<SeededId> parse(std::string_view id);

  std::string text() const { return seed + "-" + std::to_string(n); }
};

}
