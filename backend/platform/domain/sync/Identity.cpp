#include "platform/domain/sync/Identity.h"

#include "platform/domain/sync/Wire.h"

#include <cctype>
#include <charconv>
#include <stdexcept>
#include <utility>

namespace wm::sync {

std::string deriveId(std::string_view label, std::string_view fallback, const std::set<std::string>& taken) {
  constexpr std::size_t kBaseLimit = 40;
  std::string base;
  for (const char c : label) {
    if (base.size() == kBaseLimit) break;
    const auto byte = static_cast<unsigned char>(c);
    if (byte < 0x80 && std::isalnum(byte)) base.push_back(static_cast<char>(std::tolower(byte)));
    else if (!base.empty() && base.back() != '-') base.push_back('-');
  }
  while (!base.empty() && base.back() == '-') base.pop_back();
  if (base.empty()) base = fallback;

  std::string id = base;
  for (int suffix = 2; taken.contains(id); ++suffix) id = base + "-" + std::to_string(suffix);
  return id;
}

SeededId SeededId::of(const TypeDef& type, std::string seed, std::int64_t n) {
  if (!type.seeded) throw std::invalid_argument(type.name + " does not seed ids");
  if (seed.size() > static_cast<std::size_t>(type.seeded->seedMax) || !type.idPattern || !type.idPattern->matches(seed))
    throw std::invalid_argument("a seed is an id of the type of at most seedMax characters");
  if (n < 1 || n > type.seeded->ordinalMax) throw std::invalid_argument("an ordinal lies in 1..ordinalMax");
  SeededId id{std::move(seed), n};
  if (!type.idPattern->matches(id.text())) throw std::invalid_argument("a seeded id matches the type's pattern");
  return id;
}

std::optional<SeededId> SeededId::parse(std::string_view id) {
  const std::size_t cut = id.rfind('-');
  if (cut == std::string_view::npos || cut == 0) return std::nullopt;
  const std::string_view ordinal = id.substr(cut + 1);
  if (ordinal.empty() || ordinal.front() == '0') return std::nullopt;
  std::int64_t n = 0;
  const auto [end, error] = std::from_chars(ordinal.data(), ordinal.data() + ordinal.size(), n);
  if (error != std::errc{} || end != ordinal.data() + ordinal.size()) return std::nullopt;
  return SeededId{std::string(id.substr(0, cut)), n};
}

Op opOf(const TypeDef& type, const Delta& delta) {
  const std::optional<Life>& life = delta.lattice.life;
  const std::optional<Stamp>& born = delta.lattice.born;
  if (type.identity == Identity::minted || type.identity == Identity::derived) {
    if (!born) return Op::invalid;
    if (!life) return Op::update;
    if (!life->alive()) return Op::remove;
    return life->stamp == *born ? Op::create : Op::revive;
  }
  if (born) return Op::invalid;
  if (type.identity == Identity::keyed && type.life) return life ? Op::put : Op::invalid;
  return life ? Op::invalid : Op::write;
}

std::string_view nameOf(Op op) {
  switch (op) {
    case Op::create: return "create";
    case Op::update: return "update";
    case Op::remove: return "delete";
    case Op::revive: return "revive";
    case Op::put: return "put";
    case Op::write: return "write";
    case Op::invalid: break;
  }
  return "invalid";
}

std::string_view nameOf(IdState::Kind kind) {
  switch (kind) {
    case IdState::Kind::none: return "none";
    case IdState::Kind::foreign: return "foreign";
    case IdState::Kind::alive: return "alive";
    case IdState::Kind::dead: break;
  }
  return "dead";
}

Decision decide(const TypeDef& type, Op op, const IdState& state, const std::optional<Stamp>& deltaBorn) {
  using Verdict = Decision::Verdict;
  using Kind = IdState::Kind;
  const Decision apply{Verdict::apply, ""};
  const Decision ok{Verdict::ok, ""};
  auto refuse = [](const std::string& code) { return Decision{Verdict::refuse, code}; };

  if (op == Op::invalid) return refuse(code::invalid);
  if (op == Op::put || op == Op::write) return apply;
  const bool sameBorn = state.born == deltaBorn;
  const bool alive = state.kind == Kind::alive;
  const bool elsewhere = state.kind == Kind::none || state.kind == Kind::foreign;

  switch (op) {
    case Op::create:
      if (state.kind == Kind::none) return apply;
      if (state.kind == Kind::foreign) return refuse(code::idTaken);
      if (alive) return sameBorn ? apply : refuse(code::idTaken);
      return sameBorn ? ok : refuse(code::idSpent);
    case Op::update:
      if (elsewhere || !sameBorn) return refuse(code::unknownRecord);
      return alive ? apply : refuse(code::recordDead);
    case Op::remove:
      if (elsewhere || !sameBorn) return ok;
      return apply;
    case Op::revive:
      if (elsewhere || !sameBorn) return refuse(code::unknownRecord);
      if (alive) return apply;
      return type.revivable ? apply : refuse(code::idSpent);
    default:
      break;
  }
  return refuse(code::invalid);
}

}
