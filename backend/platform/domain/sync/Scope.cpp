#include "platform/domain/sync/Scope.h"

#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <utility>

namespace wm::sync {

namespace {

std::vector<std::string_view> partsOf(std::string_view text) {
  std::vector<std::string_view> parts;
  std::size_t start = 0;
  for (std::size_t slash = text.find('/'); slash != std::string_view::npos; slash = text.find('/', start)) {
    parts.push_back(text.substr(start, slash - start));
    start = slash + 1;
  }
  parts.push_back(text.substr(start));
  return parts;
}

}

ScopeKey::ScopeKey(ScopeKind kind, std::string text, UserId account, std::string product, std::string tree)
    : kind_(kind), text_(std::move(text)), account_(std::move(account)), product_(std::move(product)), tree_(std::move(tree)) {}

ScopeKey ScopeKey::product(const UserId& account, const std::string& product) {
  return ScopeKey(ScopeKind::product, "acct:" + account.str() + "/" + product, account, product, "");
}

ScopeKey ScopeKey::tree(const std::string& tree) {
  return ScopeKey(ScopeKind::tree, "tree:" + tree, UserId{}, "", tree);
}

ScopeKey ScopeKey::overlay(const UserId& account, const std::string& tree) {
  return ScopeKey(ScopeKind::overlay, "acct:" + account.str() + "/overlay/" + tree, account, "", tree);
}

std::optional<ScopeKey> ScopeKey::parse(std::string_view key) {
  if (key.starts_with("tree:") && key.size() > 5) return tree(std::string(key.substr(5)));
  if (!key.starts_with("acct:")) return std::nullopt;
  const std::vector<std::string_view> parts = partsOf(key.substr(5));
  if (parts.size() == 2 && !parts[0].empty() && !parts[1].empty()) return product(UserId{std::string(parts[0])}, std::string(parts[1]));
  if (parts.size() == 3 && !parts[0].empty() && parts[1] == "overlay" && !parts[2].empty())
    return overlay(UserId{std::string(parts[0])}, std::string(parts[2]));
  return std::nullopt;
}

std::string ScopeKey::ref() const {
  if (kind_ == ScopeKind::tree) return "tree/" + tree_;
  if (kind_ == ScopeKind::overlay) return "self/overlay/" + tree_;
  return "self/" + product_;
}

std::optional<ScopeKey> resolve(const Registry& registry, std::string_view ref, const std::optional<UserId>& caller) {
  const std::vector<std::string_view> parts = partsOf(ref);
  auto isTreeId = [&registry](std::string_view tree) {
    const TypeDef* governing = registry.governingType();
    return governing && !tree.empty() && governing->idPattern->matches(tree);
  };
  if (parts.size() == 2 && parts[0] == "tree") return isTreeId(parts[1]) ? std::optional(ScopeKey::tree(std::string(parts[1]))) : std::nullopt;
  if (!caller || parts[0] != "self") return std::nullopt;
  if (parts.size() == 2 && registry.products().contains(std::string(parts[1]))) return ScopeKey::product(*caller, std::string(parts[1]));
  if (parts.size() == 3 && parts[1] == "overlay" && isTreeId(parts[2])) return ScopeKey::overlay(*caller, std::string(parts[2]));
  return std::nullopt;
}

Access accessOf(const ScopeKey& target, const std::optional<ScopeFacts>& scope, const std::optional<ScopeFacts>& tree,
                const std::optional<UserId>& caller) {
  if (target.kind() == ScopeKind::product) return Access{.read = true, .write = true, .create = !scope};
  if (!tree) return Access{.refusal = code::notFound};
  const bool owner = caller && tree->owner == *caller;
  if (tree->dead) return Access{.gone = owner, .refusal = owner ? code::scopeDead : code::notFound};
  if (!owner && !tree->open) return Access{.refusal = code::notFound};
  if (target.kind() == ScopeKind::tree) return Access{.read = true, .write = owner, .refusal = owner ? "" : code::forbidden};
  return Access{.read = true, .write = true, .create = !scope};
}

bool Opening::opens(const Row& row) const {
  const auto reg = row.lattice.f.find(field);
  if (reg == row.lattice.f.end() || !reg->second.value.isString()) return false;
  return std::find(values.begin(), values.end(), reg->second.value.asString()) != values.end();
}

std::optional<Opening> openingOf(const Registry& registry) {
  for (const TypeDef& type : registry.types()) {
    if (type.scope.kind != ScopeKind::tree || type.identity != Identity::singleton) continue;
    for (const auto& [name, field] : type.fields) {
      if (!field.opens.empty()) return Opening{type.name, *type.singletonId, name, field.opens};
    }
  }
  return std::nullopt;
}

std::optional<ScopeLife> transition(ScopeLife from, ScopeEvent event) {
  switch (event) {
    case ScopeEvent::firstWrite:
    case ScopeEvent::governingCreate: return from == ScopeLife::absent ? std::optional(ScopeLife::alive) : std::nullopt;
    case ScopeEvent::governingDelete: return from == ScopeLife::alive ? std::optional(ScopeLife::dead) : std::nullopt;
    case ScopeEvent::horizon: return from == ScopeLife::dead ? std::optional(ScopeLife::dead) : std::nullopt;
  }
  return std::nullopt;
}

}
