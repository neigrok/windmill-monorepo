#include "platform/domain/sync/Lattice.h"

#include "platform/domain/sync/Jcs.h"

#include <set>
#include <stdexcept>

namespace wm::sync {

namespace {

template <typename Register, typename Below>
std::optional<Register> maximum(const std::optional<Register>& a, const std::optional<Register>& b, Below below) {
  if (!a) return b;
  if (!b) return a;
  return below(*a, *b) ? b : a;
}

bool lwwBelow(const Reg& a, const Reg& b) {
  if (a.stamp != b.stamp) return a.stamp < b.stamp;
  return compareJcs(a.value, b.value) < 0;
}

std::int64_t rankOf(const std::map<std::string, std::int64_t>& rank, const Json::Value& value) {
  const auto found = value.isString() ? rank.find(value.asString()) : rank.end();
  if (found == rank.end()) throw std::invalid_argument("a ranked register holds a value its field does not rank");
  return found->second;
}

std::optional<Reg> joinRegister(const FieldDef* field, const std::optional<Reg>& a, const std::optional<Reg>& b) {
  if (!field) {
    if (a && b) throw std::logic_error("two registers of a field the registry does not know meet in a join");
    return a ? a : b;
  }
  switch (field->kind) {
    case FieldKind::lww: return joinLww(a, b);
    case FieldKind::ranked: return joinRanked(a, b, field->rank);
    case FieldKind::fww:
    case FieldKind::const_:
    case FieldKind::time: return joinFww(a, b);
    case FieldKind::serial:
    case FieldKind::text: break;
  }
  throw std::logic_error("the " + field->name + " field is sequenced by admission, never joined");
}

std::optional<Reg> registerOf(const LatticeRecord& record, const std::string& name) {
  const auto found = record.f.find(name);
  if (found == record.f.end()) return std::nullopt;
  return found->second;
}

}

std::optional<Reg> joinLww(const std::optional<Reg>& a, const std::optional<Reg>& b) {
  return maximum(a, b, lwwBelow);
}

std::optional<Reg> joinRanked(const std::optional<Reg>& a, const std::optional<Reg>& b,
                              const std::map<std::string, std::int64_t>& rank) {
  return maximum(a, b, [&rank](const Reg& x, const Reg& y) {
    const std::int64_t rankX = rankOf(rank, x.value);
    const std::int64_t rankY = rankOf(rank, y.value);
    if (rankX != rankY) return rankX < rankY;
    return lwwBelow(x, y);
  });
}

std::optional<Reg> joinFww(const std::optional<Reg>& a, const std::optional<Reg>& b) {
  return maximum(a, b, [](const Reg& x, const Reg& y) { return lwwBelow(y, x); });
}

std::optional<Life> joinLife(const std::optional<Life>& a, const std::optional<Life>& b) {
  return maximum(a, b, [](const Life& x, const Life& y) {
    if (x.stamp != y.stamp) return x.stamp < y.stamp;
    return x.state == LifeState::dead && y.state == LifeState::alive;
  });
}

std::optional<Stamp> joinBorn(const std::optional<Stamp>& a, const std::optional<Stamp>& b) {
  return maximum(a, b, [](const Stamp& x, const Stamp& y) { return y < x; });
}

LatticeRecord joinRecord(const TypeDef& type, const LatticeRecord& a, const LatticeRecord& b) {
  LatticeRecord joined;
  joined.life = joinLife(a.life, b.life);
  joined.born = joinBorn(a.born, b.born);
  std::set<std::string> names;
  for (const auto& [name, reg] : a.f) names.insert(name);
  for (const auto& [name, reg] : b.f) names.insert(name);
  for (const std::string& name : names) joined.f.emplace(name, *joinRegister(type.field(name), registerOf(a, name), registerOf(b, name)));
  return joined;
}

}
