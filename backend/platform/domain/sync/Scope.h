#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"

#include <compare>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::sync {

// D-4: a server scope, keyed 'acct:<A>/<product>', 'tree:<T>' or 'acct:<A>/overlay/<T>'.
class ScopeKey {
public:
  static ScopeKey product(const UserId& account, const std::string& product);
  static ScopeKey tree(const std::string& tree);
  static ScopeKey overlay(const UserId& account, const std::string& tree);
  static std::optional<ScopeKey> parse(std::string_view key);

  ScopeKind kind() const { return kind_; }
  const std::string& text() const { return text_; }
  const UserId& account() const { return account_; }       // product and overlay scopes
  const std::string& product() const { return product_; }  // product scopes
  const std::string& treeId() const { return tree_; }      // tree and overlay scopes

  // The registry scope whose types and commands live here.
  RegistryScope registryScope() const { return RegistryScope{kind_, product_}; }
  // tree:<T> for a tree or an overlay of it.
  ScopeKey governingTree() const { return ScopeKey::tree(tree_); }
  // §9.1 ScopeRef as its owner names it: 'self/<p>', 'tree/<T>' or 'self/overlay/<T>'.
  std::string ref() const;

  bool operator==(const ScopeKey& other) const { return text_ == other.text_; }
  std::strong_ordering operator<=>(const ScopeKey& other) const { return text_ <=> other.text_; }

private:
  ScopeKey(ScopeKind kind, std::string text, UserId account, std::string product, std::string tree);

  ScopeKind kind_ = ScopeKind::product;
  std::string text_;
  UserId account_;
  std::string product_;
  std::string tree_;
};

// §9.1 ScopeRef to its server key, `self` being the caller: nullopt for a reference the registry does not
// declare (a tree or overlay whose <T> is outside the governing type's idPattern among them), a device scope
// (never sent), or `self/…` without a caller. Admission refuses such a reference invalid; a pull and a sub
// answer it not-found.
std::optional<ScopeKey> resolve(const Registry&, std::string_view ref, const std::optional<UserId>& caller);

// What the D-4 access rule reads of one sync_scopes row.
struct ScopeFacts {
  UserId owner;
  bool dead = false;
  bool open = false;
};

// The D-4 answer for one principal on one scope: a write's refusal (§6.1 step 3.7), a read's answer
// (§6.7 step 1: `gone` only for the owner of a dead tree), and whether a write inserts the absent scope.
struct Access {
  bool read = false;
  bool write = false;
  bool create = false;
  bool gone = false;
  std::string refusal;
};

// `scope` is the target's own row and `tree` its governing tree's row (a tree's own row for a tree). An
// overlay answers as its tree does; readable is the owner, or anyone while the tree is open.
Access accessOf(const ScopeKey& target, const std::optional<ScopeFacts>& scope, const std::optional<ScopeFacts>& tree,
                const std::optional<UserId>& caller);

// D-4 and §2.4: the one field whose values open a tree to every reader, a server-written field of a tree
// singleton; nullopt when the registry declares none.
struct Opening {
  std::string type;
  std::string id;
  std::string field;
  std::vector<std::string> values;

  // Whether `row`, a record of the opening type, holds an opening value.
  bool opens(const Row& row) const;
};
std::optional<Opening> openingOf(const Registry&);

// §8.3: a server scope's lifecycle. A first write or a governing create brings a scope alive, a governing
// delete kills it with its overlays, and the horizon empties a dead scope without reviving it (INV-13).
enum class ScopeLife { absent, alive, dead };
enum class ScopeEvent { firstWrite, governingCreate, governingDelete, horizon };

// The state `event` takes a scope in `from` to, or nullopt when §8.3 has no such transition.
std::optional<ScopeLife> transition(ScopeLife from, ScopeEvent event);

}
