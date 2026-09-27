#pragma once

#include <json/json.h>

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace wm::sync {

// A registry document that breaks packages/api-contract/sync/registry.schema.json or a §2.4 rule. The
// message names the path of the offending part.
struct RegistryError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// An anchored ECMAScript regular expression, compiled once. It matches bytes, so a pattern that must
// count non-ASCII characters cannot use '.'.
class Pattern {
public:
  explicit Pattern(std::string source);

  bool matches(std::string_view text) const;
  const std::string& source() const { return source_; }

private:
  std::string source_;
  std::regex regex_;
};

// A number field's step: an integer q, or 1/k for an integer k (SPEC-GAP 12). A value rounds half away
// from zero in doubles, as round(x / q) × q or round(x × k) ÷ k, and the server admits only a value the
// rounding leaves unchanged.
class Quantum {
public:
  explicit Quantum(double step);

  double step() const { return step_; }
  double round(double value) const;
  bool holds(double value) const { return round(value) == value; }

private:
  double step_;
  double stepsPerUnit_;  // k for a step 1/k; 0 for an integer step
};

enum class Unit { chars, bytes };

// A value's shape (registry.schema.json `domain`). Each type reads only its own members; `nullable`
// admits null as well.
struct Domain {
  enum class Type { string, number, boolean, fracKey, stamp, id, json, array, object };
  struct Property;

  Type type = Type::json;
  bool nullable = false;

  std::vector<std::string> oneOf;  // string `enum`
  std::optional<Pattern> pattern;
  std::optional<Unit> unit;
  std::optional<std::int64_t> minLength;
  std::optional<std::int64_t> maxLength;

  bool integer = false;
  std::optional<double> min;
  std::optional<double> max;

  std::shared_ptr<const Domain> items;
  std::optional<std::int64_t> maxItems;

  std::vector<Property> properties;
  std::vector<std::string> required;
};

struct Domain::Property {
  std::string name;
  Domain domain;
};

enum class ScopeKind { product, tree, overlay };

// Where the registry puts a type or a command (D-4): the scope of one product (`product:<name>`), or
// the `tree` or `overlay` kind.
struct RegistryScope {
  ScopeKind kind = ScopeKind::product;
  std::string product;  // product scopes only

  bool operator==(const RegistryScope&) const = default;
};

// D-23: who may write a type by a delta outside a command, or call a command.
struct Origins {
  bool replica = false;
  bool server = false;
};

// D-9.
enum class FieldKind { lww, ranked, fww, const_, time, serial, text };
enum class Writer { client, server };

struct FieldDef {
  std::string name;
  FieldKind kind = FieldKind::lww;
  Writer writer = Writer::client;
  std::optional<std::string> ref;  // D-10: the type whose id the field holds
  bool parent = false;             // the one ref whose target must be alive (§6.1 step 9)
  std::optional<Unit> unit;
  std::optional<std::int64_t> min;
  std::optional<std::int64_t> max;
  std::optional<Domain> domain;
  std::optional<Quantum> quantum;
  std::vector<std::string> serialNext;
  std::map<std::string, std::int64_t> rank;  // a ranked field's values and their ranks
  std::vector<std::string> opens;            // D-4: values of a tree singleton's server field that open the tree to every reader

  // Life, born and these kinds are the lattice fields (§3.2); serial and text are server-sequenced.
  bool isLattice() const;
};

// D-8.
enum class Identity { minted, derived, keyed, singleton };
enum class IdSpace { scope, global };
enum class DeadRows { keep, spent };

struct KeyPart {
  std::string name;
  std::string ref;
};

struct Seeding {
  std::int64_t seedMax = 0;
  std::int64_t ordinalMax = 0;
};

// D-8: a CSPRNG id is the prefix, then `length` characters drawn uniformly from `alphabet`.
struct MintRecipe {
  std::string prefix;
  std::string alphabet;
  std::int64_t length = 0;
};

struct TypeDef {
  std::string name;
  RegistryScope scope;
  Identity identity = Identity::minted;
  std::optional<IdSpace> idSpace;
  std::optional<Pattern> idPattern;
  std::optional<std::string> keyRef;  // a keyed type whose key is one id of this type
  std::vector<KeyPart> keyTuple;      // a keyed type whose key is an array of ids, its JCS the identity
  std::optional<std::string> singletonId;
  std::optional<std::string> deriveFallback;  // D-26
  std::optional<MintRecipe> mint;             // minted and derived types
  std::optional<Seeding> seeded;              // D-8
  bool life = false;
  bool revivable = false;
  std::optional<DeadRows> deadRows;
  bool governsTree = false;  // D-5: each record creates and kills `tree:<id>`
  Origins origins;
  std::map<std::string, FieldDef> fields;
  std::optional<std::int64_t> cap;  // D-24
  std::vector<std::string> visibleWhen;
  bool primary = false;  // §9.2 holdsRecords

  const FieldDef* field(std::string_view fieldName) const;
};

enum class ArgType { json, time, instant, ref };

struct ArgDef {
  std::string name;
  ArgType type = ArgType::json;
  std::optional<std::string> ref;  // `ref<t>`
  bool optional = false;
  std::optional<Domain> domain;
};

struct CommandDef {
  std::string name;
  RegistryScope scope;
  Origins origins;
  bool serverInternal = false;
  bool beforePull = false;  // §6.7: runs in its own admission before every pull of its scope
  std::map<std::string, ArgDef> args;
  std::vector<std::string> predicts;
};

// A row of a product's device scope `device/<product>`: never sent, never merged.
struct DeviceRowDef {
  std::string name;
  Pattern keyPattern;
  bool localOnly = false;
  std::optional<Domain> value;
};

struct ProductDef {
  std::string name;
  std::vector<std::string> surfaces;
  std::map<std::string, DeviceRowDef> device;
};

// §2.4 and D-7: every synced type, field and command, read from a document in registry.schema.json's
// format. Construction validates the whole document and throws RegistryError, so a process never runs
// on a registry it could misread. Types and commands keep the document's order.
class Registry {
public:
  explicit Registry(const Json::Value& document);

  const std::string& name() const { return name_; }
  std::int64_t version() const { return version_; }
  std::int64_t minVersion() const { return minVersion_; }
  const std::map<std::string, ProductDef>& products() const { return products_; }
  const std::vector<TypeDef>& types() const { return types_; }
  const std::vector<CommandDef>& commands() const { return commands_; }

  const TypeDef* type(std::string_view typeName) const;
  const CommandDef* command(std::string_view commandName) const;
  // D-5: the type whose records govern tree scopes, whose idPattern every tree id matches; nullptr when the
  // registry declares no tree.
  const TypeDef* governingType() const;

private:
  std::string name_;
  std::int64_t version_ = 0;
  std::int64_t minVersion_ = 0;
  std::map<std::string, ProductDef> products_;
  std::vector<TypeDef> types_;
  std::vector<CommandDef> commands_;
};

}
