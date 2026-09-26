#include "platform/domain/sync/Registry.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <set>
#include <utility>

namespace wm::sync {

namespace {

const Pattern& productNames() {
  static const Pattern pattern{"^[a-z][a-z0-9]*$"};
  return pattern;
}

const Pattern& memberNames() {
  static const Pattern pattern{"^[a-z][A-Za-z0-9]*$"};
  return pattern;
}

// One object of the document, read key by key under its path: a key the schema does not allow, a
// missing key and a value of the wrong kind each fail naming the path that holds them.
class Reader {
public:
  Reader(const Json::Value& object, std::string path, std::initializer_list<const char*> allowed)
      : object_(object), path_(std::move(path)) {
    if (!object_.isObject()) fail("is not an object");
    for (const std::string& key : object_.getMemberNames()) {
      const bool known = std::any_of(allowed.begin(), allowed.end(), [&key](const char* name) { return key == name; });
      if (!known) fail("holds the unknown key \"" + key + "\"");
    }
  }

  // The same object, reported under a more telling path once its name is known.
  Reader under(std::string path) const {
    Reader named = *this;
    named.path_ = std::move(path);
    return named;
  }

  [[noreturn]] void fail(const std::string& message) const { throw RegistryError(path_ + " " + message); }
  const std::string& path() const { return path_; }
  std::string at(const std::string& key) const { return path_ + "." + key; }
  bool has(const char* key) const { return object_.isMember(key); }

  const Json::Value& value(const char* key) const {
    if (!has(key)) fail("lacks \"" + std::string(key) + "\"");
    return object_[key];
  }

  std::string string(const char* key) const {
    const Json::Value& text = value(key);
    if (!text.isString()) fail("has a \"" + std::string(key) + "\" that is not a string");
    return text.asString();
  }

  std::optional<std::string> optionalString(const char* key) const {
    if (!has(key)) return std::nullopt;
    return string(key);
  }

  // A regular expression the registry declares, compiled here so a bad one names its path.
  Pattern pattern(const char* key) const {
    const std::string source = string(key);
    try {
      return Pattern{source};
    } catch (const RegistryError& error) {
      throw RegistryError(at(key) + ": " + error.what());
    }
  }

  std::string name(const char* key, const Pattern& pattern) const {
    std::string text = string(key);
    if (!pattern.matches(text)) fail("has a \"" + std::string(key) + "\" that does not match " + pattern.source());
    return text;
  }

  bool boolean(const char* key) const {
    const Json::Value& flag = value(key);
    if (!flag.isBool()) fail("has a \"" + std::string(key) + "\" that is not a boolean");
    return flag.asBool();
  }

  bool optionalBoolean(const char* key) const { return has(key) && boolean(key); }

  // A key the schema allows only as `true`.
  bool trueOrAbsent(const char* key) const {
    if (!has(key)) return false;
    if (!boolean(key)) fail("has a \"" + std::string(key) + "\" that is not true");
    return true;
  }

  std::int64_t integer(const char* key, std::int64_t atLeast) const {
    const Json::Value& number = value(key);
    if (!number.isInt64() || number.asInt64() < atLeast)
      fail("has a \"" + std::string(key) + "\" that is not an integer of at least " + std::to_string(atLeast));
    return number.asInt64();
  }

  std::optional<std::int64_t> optionalInteger(const char* key, std::int64_t atLeast) const {
    if (!has(key)) return std::nullopt;
    return integer(key, atLeast);
  }

  std::optional<double> optionalNumber(const char* key) const {
    if (!has(key)) return std::nullopt;
    const Json::Value& number = value(key);
    if (!number.isNumeric()) fail("has a \"" + std::string(key) + "\" that is not a number");
    return number.asDouble();
  }

  // An array of distinct strings, each matching `pattern` when one is given.
  std::vector<std::string> names(const char* key, const Pattern* pattern, bool nonEmpty) const {
    const Json::Value& array = value(key);
    if (!array.isArray() || (nonEmpty && array.empty())) fail("has a \"" + std::string(key) + "\" that is not a non-empty array");
    std::vector<std::string> out;
    for (const Json::Value& item : array) {
      if (!item.isString() || (pattern && !pattern->matches(item.asString())))
        fail("has a \"" + std::string(key) + "\" item that is not a valid name");
      if (std::find(out.begin(), out.end(), item.asString()) != out.end())
        fail("has a \"" + std::string(key) + "\" that repeats " + item.asString());
      out.push_back(item.asString());
    }
    return out;
  }

  template <typename Choice>
  Choice oneOf(const char* key, std::initializer_list<std::pair<const char*, Choice>> choices) const {
    const std::string text = string(key);
    for (const auto& [spelling, choice] : choices) {
      if (text == spelling) return choice;
    }
    fail("has a \"" + std::string(key) + "\" outside its enumeration: " + text);
  }

private:
  const Json::Value& object_;
  std::string path_;
};

Unit unitOf(const Reader& reader, const char* key) {
  return reader.oneOf<Unit>(key, {{"chars", Unit::chars}, {"bytes", Unit::bytes}});
}

Domain domainOf(const Json::Value& json, const std::string& path) {
  if (!json.isObject() || !json["type"].isString()) throw RegistryError(path + " is not a domain with a \"type\"");
  const std::string type = json["type"].asString();

  if (type == "string") {
    const Reader reader(json, path, {"type", "nullable", "enum", "pattern", "unit", "min", "max"});
    Domain domain{.type = Domain::Type::string, .nullable = reader.optionalBoolean("nullable")};
    if (reader.has("enum")) domain.oneOf = reader.names("enum", nullptr, true);
    if (reader.has("pattern")) domain.pattern = reader.pattern("pattern");
    if (reader.has("unit")) domain.unit = unitOf(reader, "unit");
    domain.minLength = reader.optionalInteger("min", 0);
    domain.maxLength = reader.optionalInteger("max", 1);
    return domain;
  }
  if (type == "number") {
    const Reader reader(json, path, {"type", "nullable", "integer", "min", "max"});
    return Domain{.type = Domain::Type::number,
                  .nullable = reader.optionalBoolean("nullable"),
                  .integer = reader.optionalBoolean("integer"),
                  .min = reader.optionalNumber("min"),
                  .max = reader.optionalNumber("max")};
  }
  if (type == "array") {
    const Reader reader(json, path, {"type", "nullable", "items", "maxItems"});
    return Domain{.type = Domain::Type::array,
                  .nullable = reader.optionalBoolean("nullable"),
                  .items = std::make_shared<const Domain>(domainOf(reader.value("items"), reader.at("items"))),
                  .maxItems = reader.optionalInteger("maxItems", 0)};
  }
  if (type == "object") {
    const Reader reader(json, path, {"type", "nullable", "properties", "required"});
    Domain domain{.type = Domain::Type::object, .nullable = reader.optionalBoolean("nullable")};
    const Json::Value& properties = reader.value("properties");
    if (!properties.isObject()) reader.fail("has \"properties\" that are not an object");
    for (const std::string& name : properties.getMemberNames()) {
      if (!memberNames().matches(name)) reader.fail("names the property \"" + name + "\" against " + memberNames().source());
      domain.properties.push_back(Domain::Property{name, domainOf(properties[name], reader.at("properties." + name))});
    }
    if (reader.has("required")) domain.required = reader.names("required", &memberNames(), false);
    for (const std::string& name : domain.required) {
      const bool declared = std::any_of(domain.properties.begin(), domain.properties.end(),
                                        [&name](const Domain::Property& property) { return property.name == name; });
      if (!declared) reader.fail("requires the undeclared property \"" + name + "\"");
    }
    return domain;
  }

  const Reader reader(json, path, {"type", "nullable"});
  return Domain{.type = reader.oneOf<Domain::Type>("type", {{"boolean", Domain::Type::boolean},
                                                           {"fracKey", Domain::Type::fracKey},
                                                           {"stamp", Domain::Type::stamp},
                                                           {"id", Domain::Type::id},
                                                           {"json", Domain::Type::json}}),
                .nullable = reader.optionalBoolean("nullable")};
}

RegistryScope scopeOf(const Reader& reader) {
  const std::string text = reader.string("scope");
  if (text == "tree") return RegistryScope{ScopeKind::tree, ""};
  if (text == "overlay") return RegistryScope{ScopeKind::overlay, ""};
  const std::string prefix = "product:";
  if (text.starts_with(prefix) && productNames().matches(text.substr(prefix.size())))
    return RegistryScope{ScopeKind::product, text.substr(prefix.size())};
  reader.fail("has the scope \"" + text + "\", which is not product:<name>, tree or overlay");
}

Origins originsOf(const Reader& reader) {
  Origins origins;
  for (const std::string& origin : reader.names("origins", nullptr, true)) {
    if (origin == "replica") origins.replica = true;
    else if (origin == "server") origins.server = true;
    else reader.fail("has the unknown origin \"" + origin + "\"");
  }
  return origins;
}

FieldDef fieldOf(const std::string& name, const Json::Value& json, const std::string& path) {
  const Reader reader(json, path, {"kind", "writer", "ref", "parent", "unit", "min", "max", "domain", "quantum", "serialNext", "rank", "opens"});
  FieldDef field{
      .name = name,
      .kind = reader.oneOf<FieldKind>("kind", {{"lww", FieldKind::lww},
                                               {"ranked", FieldKind::ranked},
                                               {"fww", FieldKind::fww},
                                               {"const", FieldKind::const_},
                                               {"time", FieldKind::time},
                                               {"serial", FieldKind::serial},
                                               {"text", FieldKind::text}}),
      .writer = reader.oneOf<Writer>("writer", {{"client", Writer::client}, {"server", Writer::server}}),
      .parent = reader.trueOrAbsent("parent"),
      .min = reader.optionalInteger("min", 0),
      .max = reader.optionalInteger("max", 1),
  };
  if (reader.has("ref")) field.ref = reader.name("ref", memberNames());
  if (reader.has("unit")) field.unit = unitOf(reader, "unit");
  if (reader.has("domain")) field.domain = domainOf(reader.value("domain"), reader.at("domain"));
  if (reader.has("serialNext")) field.serialNext = reader.names("serialNext", &memberNames(), false);
  if (reader.has("opens")) field.opens = reader.names("opens", nullptr, true);
  if (reader.has("quantum")) {
    try {
      field.quantum = Quantum{*reader.optionalNumber("quantum")};
    } catch (const RegistryError& error) {
      throw RegistryError(reader.at("quantum") + ": " + error.what());
    }
    if (!field.domain || field.domain->type != Domain::Type::number) reader.fail("has a quantum without a number domain");
  }
  if (reader.has("rank")) {
    const Json::Value& rank = reader.value("rank");
    if (!rank.isObject() || rank.empty()) reader.fail("has a \"rank\" that is not a non-empty object");
    for (const std::string& value : rank.getMemberNames()) {
      if (!rank[value].isInt64()) reader.fail("ranks \"" + value + "\" with a value that is not an integer");
      field.rank[value] = rank[value].asInt64();
    }
  }

  if (field.kind == FieldKind::ranked && field.rank.empty()) reader.fail("is ranked without a \"rank\"");
  if (field.kind == FieldKind::ranked && field.domain) {
    std::set<std::string> ranked;
    for (const auto& [value, rank] : field.rank) ranked.insert(value);
    const std::set<std::string> domainValues(field.domain->oneOf.begin(), field.domain->oneOf.end());
    if (field.domain->type != Domain::Type::string || ranked != domainValues)
      reader.fail("ranks values other than its domain's");
  }
  if (field.kind == FieldKind::serial && (!reader.has("serialNext") || field.writer != Writer::server))
    reader.fail("is serial without \"serialNext\" and the server as its writer");
  if (field.kind == FieldKind::text && (!field.unit || !field.max)) reader.fail("is text without a \"unit\" and a \"max\"");
  if (field.parent && !field.ref) reader.fail("is a parent without a \"ref\"");
  if (!field.opens.empty() && field.writer != Writer::server) reader.fail("opens a tree without the server as its writer");
  for (const std::string& value : field.opens) {
    const bool inDomain = !field.domain || field.domain->oneOf.empty() ||
                          std::find(field.domain->oneOf.begin(), field.domain->oneOf.end(), value) != field.domain->oneOf.end();
    if (!inDomain) reader.fail("opens a tree on \"" + value + "\", which its domain does not hold");
  }
  return field;
}

// §2.4's rules that tie one type's parts together, once each part has its own shape.
void checkType(const Reader& reader, const TypeDef& type) {
  const bool mintedOrDerived = type.identity == Identity::minted || type.identity == Identity::derived;
  if (mintedOrDerived && !(type.idSpace && type.idPattern && reader.has("revivable") && type.deadRows && type.mint))
    reader.fail("is minted or derived without \"idSpace\", \"idPattern\", \"revivable\", \"deadRows\" and \"mint\"");
  if (type.mint && type.idPattern) {
    for (const char c : type.mint->alphabet) {
      if (!type.idPattern->matches(type.mint->prefix + std::string(static_cast<std::size_t>(type.mint->length), c)))
        reader.fail("mints ids its idPattern refuses");
    }
  }
  if (mintedOrDerived && !type.life) reader.fail("is minted or derived without life");
  if (type.identity == Identity::derived && !type.deriveFallback) reader.fail("is derived without \"derive\"");
  if (type.identity == Identity::singleton && (!type.singletonId || !type.idPattern || type.life))
    reader.fail("is a singleton without \"singletonId\" and \"idPattern\", or with life");
  if (type.singletonId && type.idPattern && !type.idPattern->matches(*type.singletonId))
    reader.fail("has a singletonId its idPattern refuses");
  if (type.identity == Identity::keyed && type.life && !type.deadRows) reader.fail("is keyed with life without \"deadRows\"");
  if (!reader.has("key") && !type.idPattern) reader.fail("has neither a \"key\" nor an \"idPattern\"");
  if (type.seeded && type.identity != Identity::minted) reader.fail("seeds ids without being minted");
  if (type.revivable && type.deadRows != DeadRows::keep) reader.fail("is revivable without keeping its dead rows");
  if (type.governsTree && (type.identity != Identity::minted || type.revivable || type.scope.kind != ScopeKind::product))
    reader.fail("governs a tree without being a terminal minted type of a product scope");
  if (!type.origins.replica) reader.fail("has origins without replica");
  if (!type.visibleWhen.empty() && type.life) reader.fail("declares visibleWhen with life");
  for (const std::string& fieldName : type.visibleWhen) {
    if (!type.field(fieldName)) reader.fail("makes the unknown field \"" + fieldName + "\" visibleWhen");
  }
  const auto parents = std::count_if(type.fields.begin(), type.fields.end(), [](const auto& entry) { return entry.second.parent; });
  if (parents > 1) reader.fail("has more than one parent field");
  for (const auto& [fieldName, field] : type.fields) {
    if (!field.opens.empty() && (type.scope.kind != ScopeKind::tree || type.identity != Identity::singleton))
      reader.fail("opens a tree from \"" + fieldName + "\", which is not a field of a tree singleton");
    for (const std::string& next : field.serialNext) {
      if (!type.field(next)) reader.fail("numbers \"" + fieldName + "\" after the unknown field \"" + next + "\"");
    }
  }
}

TypeDef typeOf(const Json::Value& json, const std::string& elementPath) {
  const Reader element(json, elementPath,
                       {"type", "scope", "identity", "idSpace", "idPattern", "key", "singletonId", "derive", "mint", "seeded",
                        "life", "revivable", "deadRows", "governs", "origins", "fields", "cap", "visibleWhen", "primary"});
  const std::string name = element.name("type", memberNames());
  const Reader reader = element.under("registry.types." + name);
  TypeDef type{
      .name = name,
      .scope = scopeOf(reader),
      .identity = reader.oneOf<Identity>("identity", {{"minted", Identity::minted},
                                                      {"derived", Identity::derived},
                                                      {"keyed", Identity::keyed},
                                                      {"singleton", Identity::singleton}}),
      .singletonId = reader.optionalString("singletonId"),
      .life = reader.boolean("life"),
      .revivable = reader.optionalBoolean("revivable"),
      .origins = originsOf(reader),
      .cap = reader.optionalInteger("cap", 1),
      .primary = reader.trueOrAbsent("primary"),
  };
  if (reader.has("idSpace")) type.idSpace = reader.oneOf<IdSpace>("idSpace", {{"scope", IdSpace::scope}, {"global", IdSpace::global}});
  if (reader.has("idPattern")) type.idPattern = reader.pattern("idPattern");
  if (reader.has("deadRows")) type.deadRows = reader.oneOf<DeadRows>("deadRows", {{"keep", DeadRows::keep}, {"spent", DeadRows::spent}});
  if (reader.has("governs")) type.governsTree = reader.oneOf<bool>("governs", {{"tree", true}});
  if (reader.has("visibleWhen")) type.visibleWhen = reader.names("visibleWhen", &memberNames(), true);
  if (reader.has("key")) {
    const Reader key(reader.value("key"), reader.at("key"), {"ref", "tuple"});
    if (key.has("ref") == key.has("tuple")) key.fail("is neither {ref} nor {tuple}");
    if (key.has("ref")) type.keyRef = key.name("ref", memberNames());
    if (key.has("tuple")) {
      const Json::Value& tuple = key.value("tuple");
      if (!tuple.isArray() || tuple.size() < 2) key.fail("has a tuple of fewer than two parts");
      for (Json::ArrayIndex i = 0; i < tuple.size(); ++i) {
        const Reader part(tuple[i], key.at("tuple[" + std::to_string(i) + "]"), {"name", "ref"});
        type.keyTuple.push_back(KeyPart{part.name("name", memberNames()), part.name("ref", memberNames())});
      }
    }
  }
  if (reader.has("derive")) {
    const Reader derive(reader.value("derive"), reader.at("derive"), {"fallback"});
    static const Pattern slug{"^[a-z0-9]+(-[a-z0-9]+)*$"};
    type.deriveFallback = derive.name("fallback", slug);
  }
  if (reader.has("mint")) {
    const Reader mint(reader.value("mint"), reader.at("mint"), {"prefix", "alphabet", "length"});
    type.mint = MintRecipe{mint.string("prefix"), mint.string("alphabet"), mint.integer("length", 1)};
    if (type.mint->alphabet.size() < 2) mint.fail("has an alphabet of fewer than two characters");
  }
  if (reader.has("seeded")) {
    const Reader seeded(reader.value("seeded"), reader.at("seeded"), {"seedMax", "ordinalMax"});
    type.seeded = Seeding{seeded.integer("seedMax", 1), seeded.integer("ordinalMax", 1)};
  }
  const Json::Value& fields = reader.value("fields");
  if (!fields.isObject()) reader.fail("has \"fields\" that are not an object");
  for (const std::string& fieldName : fields.getMemberNames()) {
    if (!memberNames().matches(fieldName)) reader.fail("names the field \"" + fieldName + "\" against " + memberNames().source());
    type.fields.emplace(fieldName, fieldOf(fieldName, fields[fieldName], reader.at("fields." + fieldName)));
  }

  checkType(reader, type);
  return type;
}

CommandDef commandOf(const Json::Value& json, const std::string& elementPath) {
  const Reader element(json, elementPath, {"name", "scope", "origins", "serverInternal", "beforePull", "args", "predicts"});
  static const Pattern commandNames{"^[a-z][a-z0-9]*\\.[a-z][A-Za-z0-9]*$"};
  const std::string name = element.name("name", commandNames);
  const Reader reader = element.under("registry.commands." + name);
  CommandDef command{
      .name = name,
      .scope = scopeOf(reader),
      .origins = originsOf(reader),
      .serverInternal = reader.boolean("serverInternal"),
      .beforePull = reader.optionalBoolean("beforePull"),
  };
  if (reader.has("predicts")) command.predicts = reader.names("predicts", &memberNames(), false);
  const Json::Value& args = reader.value("args");
  if (!args.isObject()) reader.fail("has \"args\" that are not an object");
  static const Pattern refType{"^ref<([a-z][A-Za-z0-9]*)>$"};
  for (const std::string& argName : args.getMemberNames()) {
    if (!memberNames().matches(argName)) reader.fail("names the argument \"" + argName + "\" against " + memberNames().source());
    const Reader arg(args[argName], reader.at("args." + argName), {"type", "optional", "domain"});
    ArgDef def{.name = argName, .optional = arg.optionalBoolean("optional")};
    const std::string type = arg.string("type");
    if (refType.matches(type)) {
      def.type = ArgType::ref;
      def.ref = type.substr(4, type.size() - 5);
    } else {
      def.type = arg.oneOf<ArgType>("type", {{"json", ArgType::json}, {"time", ArgType::time}, {"instant", ArgType::instant}});
    }
    if (arg.has("domain")) def.domain = domainOf(arg.value("domain"), arg.at("domain"));
    command.args.emplace(argName, std::move(def));
  }
  if (command.serverInternal && command.origins.replica) reader.fail("is server-internal with a replica origin");
  if (command.beforePull && !command.serverInternal) reader.fail("runs before pulls without being server-internal");
  return command;
}

ProductDef productOf(const std::string& name, const Json::Value& json, const std::string& path) {
  const Reader reader(json, path, {"surfaces", "device"});
  ProductDef product{.name = name};
  if (reader.has("surfaces")) {
    product.surfaces = reader.names("surfaces", nullptr, false);
    for (const std::string& surface : product.surfaces) {
      if (surface != "web" && surface != "ios" && surface != "android") reader.fail("names the unknown surface \"" + surface + "\"");
    }
  }
  if (reader.has("device")) {
    const Json::Value& device = reader.value("device");
    if (!device.isObject()) reader.fail("has a \"device\" that is not an object");
    for (const std::string& rowName : device.getMemberNames()) {
      if (!memberNames().matches(rowName)) reader.fail("names the device row \"" + rowName + "\" against " + memberNames().source());
      const Reader row(device[rowName], reader.at("device." + rowName), {"keyPattern", "localOnly", "value"});
      DeviceRowDef def{.name = rowName, .keyPattern = row.pattern("keyPattern"), .localOnly = row.optionalBoolean("localOnly")};
      if (row.has("value")) def.value = domainOf(row.value("value"), row.at("value"));
      product.device.emplace(rowName, std::move(def));
    }
  }
  return product;
}

}

Pattern::Pattern(std::string source) : source_(std::move(source)) {
  if (source_.size() < 2 || source_.front() != '^' || source_.back() != '$')
    throw RegistryError("the pattern " + source_ + " is not anchored with ^ and $");
  try {
    regex_ = std::regex(source_, std::regex::ECMAScript);
  } catch (const std::regex_error&) {
    throw RegistryError("the pattern " + source_ + " does not compile");
  }
}

bool Pattern::matches(std::string_view text) const {
  return std::regex_match(text.begin(), text.end(), regex_);
}

Quantum::Quantum(double step) : step_(step), stepsPerUnit_(0) {
  if (!std::isfinite(step) || step <= 0) throw RegistryError("a quantum is a positive number");
  if (step == std::floor(step)) return;
  const double steps = std::round(1 / step);
  if (steps < 2 || 1 / steps != step) throw RegistryError("a quantum is an integer or 1/k for an integer k");
  stepsPerUnit_ = steps;
}

double Quantum::round(double value) const {
  const double rounded = stepsPerUnit_ > 0 ? std::round(value * stepsPerUnit_) / stepsPerUnit_ : std::round(value / step_) * step_;
  return rounded == 0 ? 0.0 : rounded;
}

bool FieldDef::isLattice() const {
  return kind != FieldKind::serial && kind != FieldKind::text;
}

const FieldDef* TypeDef::field(std::string_view fieldName) const {
  const auto found = fields.find(std::string(fieldName));
  return found == fields.end() ? nullptr : &found->second;
}

Registry::Registry(const Json::Value& document) {
  const Reader root(document, "registry", {"$schema", "registry", "version", "minVersion", "products", "types", "commands"});
  static const Pattern registryNames{"^[a-z][a-z0-9-]*$"};
  name_ = root.name("registry", registryNames);
  version_ = root.integer("version", 1);
  minVersion_ = root.integer("minVersion", 1);
  if (minVersion_ > version_) root.fail("has a minVersion above its version");

  const Json::Value& products = root.value("products");
  if (!products.isObject()) root.fail("has \"products\" that are not an object");
  for (const std::string& productName : products.getMemberNames()) {
    if (!productNames().matches(productName)) root.fail("names the product \"" + productName + "\" against " + productNames().source());
    products_.emplace(productName, productOf(productName, products[productName], root.at("products." + productName)));
  }

  const Json::Value& types = root.value("types");
  if (!types.isArray()) root.fail("has \"types\" that are not an array");
  for (Json::ArrayIndex i = 0; i < types.size(); ++i) {
    TypeDef type = typeOf(types[i], root.at("types[" + std::to_string(i) + "]"));
    if (this->type(type.name)) root.fail("declares the type \"" + type.name + "\" twice");
    types_.push_back(std::move(type));
  }

  const Json::Value& commands = root.value("commands");
  if (!commands.isArray()) root.fail("has \"commands\" that are not an array");
  for (Json::ArrayIndex i = 0; i < commands.size(); ++i) {
    CommandDef command = commandOf(commands[i], root.at("commands[" + std::to_string(i) + "]"));
    if (this->command(command.name)) root.fail("declares the command \"" + command.name + "\" twice");
    commands_.push_back(std::move(command));
  }

  auto requireType = [this](const std::optional<std::string>& typeName, const std::string& where) {
    if (typeName && !type(*typeName)) throw RegistryError(where + " refers to the unknown type \"" + *typeName + "\"");
  };
  auto requireProduct = [this](const RegistryScope& scope, const std::string& where) {
    if (scope.kind == ScopeKind::product && !products_.contains(scope.product))
      throw RegistryError(where + " lives in the undeclared product \"" + scope.product + "\"");
  };
  for (const TypeDef& type : types_) {
    const std::string where = "registry.types." + type.name;
    requireProduct(type.scope, where);
    requireType(type.keyRef, where + ".key");
    for (const KeyPart& part : type.keyTuple) requireType(part.ref, where + ".key." + part.name);
    for (const auto& [fieldName, field] : type.fields) requireType(field.ref, where + ".fields." + fieldName);
  }
  for (const CommandDef& command : commands_) {
    const std::string where = "registry.commands." + command.name;
    requireProduct(command.scope, where);
    for (const auto& [argName, arg] : command.args) requireType(arg.ref, where + ".args." + argName);
    for (const std::string& predicted : command.predicts) requireType(predicted, where + ".predicts");
  }
}

const TypeDef* Registry::type(std::string_view typeName) const {
  const auto found = std::find_if(types_.begin(), types_.end(), [typeName](const TypeDef& type) { return type.name == typeName; });
  return found == types_.end() ? nullptr : &*found;
}

const CommandDef* Registry::command(std::string_view commandName) const {
  const auto found =
      std::find_if(commands_.begin(), commands_.end(), [commandName](const CommandDef& command) { return command.name == commandName; });
  return found == commands_.end() ? nullptr : &*found;
}

}
