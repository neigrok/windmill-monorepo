#pragma once

#include "platform/domain/sync/Record.h"
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

// §4.1: the op a delta's shape names for its type, or invalid for any other shape.
enum class Op { create, update, remove, revive, put, write, invalid };
Op opOf(const TypeDef& type, const Delta& delta);
std::string_view nameOf(Op op);

// §4.2: an id's state in a scope, with the born of a record that has one.
struct IdState {
  enum class Kind { none, foreign, alive, dead };
  Kind kind = Kind::none;
  std::optional<Stamp> born;

  bool exists() const { return kind == Kind::alive || kind == Kind::dead; }
};
std::string_view nameOf(IdState::Kind kind);

// §4.3: what admission does with one delta. `ok` admits the intent without changing the record.
struct Decision {
  enum class Verdict { apply, ok, refuse };
  Verdict verdict = Verdict::apply;
  std::string code;
};
Decision decide(const TypeDef& type, Op op, const IdState& state, const std::optional<Stamp>& deltaBorn);

}
