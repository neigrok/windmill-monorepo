#include "platform/domain/sync/Shape.h"

#include "platform/domain/sync/FractionalIndex.h"
#include "platform/domain/sync/Identity.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <set>
#include <utility>

namespace wm::sync {

namespace {

[[noreturn]] void invalid() {
  throw Refusal(code::invalid);
}

// U+0000 anywhere in a string or a key: no store the engine runs on keeps it (Postgres text cannot), so every
// backend refuses it alike rather than one storing it and another failing.
bool holdsNul(const Json::Value& value) {
  if (value.isString()) return value.asString().find('\0') != std::string::npos;
  if (value.isArray()) return std::any_of(value.begin(), value.end(), holdsNul);
  if (!value.isObject()) return false;
  for (const std::string& key : value.getMemberNames()) {
    if (key.find('\0') != std::string::npos || holdsNul(value[key])) return true;
  }
  return false;
}

bool isEpochMs(const Json::Value& value) {
  return isSafeInteger(value) && value.asDouble() >= 0;
}

bool isNumber(const Json::Value& value) {
  return value.isNumeric() && !value.isBool() && std::isfinite(value.asDouble());
}

// D-9: a string measured as itself, any other value as its JCS, in the unit its bounds state.
bool withinBounds(const std::optional<Bounds>& bounds, const Json::Value& value) {
  if (!bounds || (!bounds->min && !bounds->max)) return true;
  const std::string measured = value.isString() ? value.asString() : jcs(value);
  const auto length = static_cast<std::int64_t>(lengthIn(bounds->unit, measured));
  return (!bounds->min || length >= *bounds->min) && (!bounds->max || length <= *bounds->max);
}

void requireKeys(const Json::Value& object, std::initializer_list<const char*> allowed) {
  for (const std::string& key : object.getMemberNames()) {
    const bool known = std::any_of(allowed.begin(), allowed.end(), [&key](const char* name) { return key == name; });
    if (!known) invalid();
  }
}

// A stamp position: a stamp that is set, or, from a server origin, null for step 9 to mint (§10.3).
Stamp stampSlot(const Json::Value& wire, const Sender& sender) {
  if (wire.isNull() && sender.server) return Stamp{};
  if (!wire.isString()) invalid();
  const std::optional<Stamp> stamp = parseHlc(wire.asString());
  if (!stamp || !stamp->isSet()) invalid();
  return *stamp;
}

const TypeDef& typeIn(const Registry& registry, const ScopeKey& scope, const Json::Value& name) {
  const TypeDef* type = name.isString() ? registry.type(name.asString()) : nullptr;
  if (!type || type->scope != scope.registryScope()) invalid();
  return *type;
}

RecordId idOf(const Registry& registry, const TypeDef& type, const Json::Value& id) {
  if (!isIdOf(registry, type, id)) invalid();
  return RecordId(id);
}

TextBase textBaseOf(const Json::Value& base) {
  if (!base.isObject() || base.size() != 1) invalid();
  if (base.isMember("text")) {
    if (!base["text"].isString()) invalid();
    return TextBase{std::nullopt, base["text"].asString()};
  }
  if (!base.isMember("rev") || !isSafeInteger(base["rev"]) || base["rev"].asDouble() < 0) invalid();
  return TextBase{static_cast<Seq>(base["rev"].asUInt64()), ""};
}

Delta deltaOf(const Registry& registry, const ScopeKey& scope, const Json::Value& wire, const Sender& sender) {
  if (!wire.isObject()) invalid();
  requireKeys(wire, {"t", "id", "life", "born", "f", "x", "v"});
  const TypeDef& type = typeIn(registry, scope, wire["t"]);
  Delta delta{.t = type.name, .id = idOf(registry, type, wire["id"])};
  if (wire.isMember("v")) invalid();

  if (wire.isMember("life")) {
    const Json::Value& life = wire["life"];
    if (!life.isArray() || life.size() != 2 || !life[0].isString() || !type.life) invalid();
    const std::string state = life[0].asString();
    if (state != "alive" && state != "dead") invalid();
    delta.lattice.life = Life(state == "alive" ? LifeState::alive : LifeState::dead, stampSlot(life[1], sender));
  }
  if (wire.isMember("born")) delta.lattice.born = stampSlot(wire["born"], sender);

  const Json::Value& registers = wire["f"];
  if (!registers.isNull() && !registers.isObject()) invalid();
  for (const std::string& name : registers.getMemberNames()) {
    const FieldDef* field = type.field(name);
    const Json::Value& reg = registers[name];
    if (!field || !field->isLattice()) invalid();
    if (!reg.isArray() || reg.size() != 2) invalid();
    const Stamp stamp = stampSlot(reg[1], sender);
    if (!sender.server && field->writer == Writer::server) invalid();
    delta.lattice.f.emplace(name, Reg(reg[0], stamp));
  }

  const Json::Value& texts = wire["x"];
  if (!texts.isNull() && !texts.isObject()) invalid();
  for (const std::string& name : texts.getMemberNames()) {
    const FieldDef* field = type.field(name);
    const Json::Value& write = texts[name];
    if (!field || field->kind != FieldKind::text || !write.isObject() || !write["text"].isString()) invalid();
    if (!sender.server && field->writer == Writer::server) invalid();
    delta.x.emplace(name, TextWrite{write["text"].asString(), textBaseOf(write["base"])});
  }

  if (opOf(type, delta) == Op::invalid) invalid();
  return delta;
}

Guard guardOf(const Registry& registry, const ScopeKey& scope, const Json::Value& wire) {
  if (!wire.isObject()) invalid();
  const TypeDef& type = typeIn(registry, scope, wire["t"]);
  Guard guard{.t = type.name, .id = idOf(registry, type, wire["id"])};
  const FieldDef* field = wire["field"].isString() ? type.field(wire["field"].asString()) : nullptr;
  if (!field || !field->isLattice()) invalid();
  guard.field = field->name;
  if (!wire.isMember("stamp")) invalid();
  if (wire["stamp"].isNull()) return guard;
  if (!wire["stamp"].isString()) invalid();
  guard.stamp = parseHlc(wire["stamp"].asString());
  if (!guard.stamp) invalid();
  return guard;
}

Cmd commandOf(const Registry& registry, const ScopeKey& scope, const Json::Value& wire, Ms bound) {
  if (!wire.isObject()) invalid();
  const CommandDef* def = wire["name"].isString() ? registry.command(wire["name"].asString()) : nullptr;
  const Json::Value& args = wire["args"];
  if (!def || def->scope != scope.registryScope() || !args.isObject()) invalid();
  for (const std::string& name : args.getMemberNames()) {
    if (!def->args.contains(name)) invalid();
  }
  for (const auto& [name, arg] : def->args) {
    if (!args.isMember(name)) {
      if (arg.optional) continue;
      invalid();
    }
    if (!admitsArgument(registry, arg, args[name])) invalid();
    if (arg.type == ArgType::instant && args[name].asDouble() > static_cast<double>(bound)) invalid();
  }
  return Cmd{def->name, args};
}

std::vector<Stamp> stampsOf(const Delta& delta) {
  std::vector<Stamp> stamps;
  if (delta.lattice.life) stamps.push_back(delta.lattice.life->stamp);
  if (delta.lattice.born) stamps.push_back(*delta.lattice.born);
  for (const auto& [name, reg] : delta.lattice.f) stamps.push_back(reg.stamp);
  return stamps;
}

void clampTimes(const Registry& registry, Intent& intent, Ms serverNow, Ms bound) {
  for (Delta& delta : intent.d) {
    const TypeDef& type = *registry.type(delta.t);
    for (auto& [name, reg] : delta.lattice.f) {
      if (type.field(name)->kind == FieldKind::time && reg.value.asDouble() > static_cast<double>(bound)) reg.value = Json::UInt64(serverNow);
    }
  }
  if (!intent.cmd) return;
  Json::Value& args = intent.cmd->args;
  for (const auto& [name, arg] : registry.command(intent.cmd->name)->args) {
    if (arg.type == ArgType::time && args.isMember(name) && args[name].asDouble() > static_cast<double>(bound)) args[name] = Json::UInt64(serverNow);
  }
}

}

std::size_t lengthIn(Unit unit, std::string_view text) {
  if (unit == Unit::bytes) return text.size();
  return static_cast<std::size_t>(std::count_if(text.begin(), text.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
}

bool admits(const Domain& domain, const Json::Value& value) {
  if (value.isNull()) return domain.nullable;
  switch (domain.type) {
    case Domain::Type::string: {
      if (!value.isString()) return false;
      const std::string text = value.asString();
      if (!domain.oneOf.empty() && std::find(domain.oneOf.begin(), domain.oneOf.end(), text) == domain.oneOf.end()) return false;
      if (domain.pattern && !domain.pattern->matches(text)) return false;
      return withinBounds(domain.bounds, value);
    }
    case Domain::Type::number: {
      if (!isNumber(value)) return false;
      if (domain.integer && !isSafeInteger(value)) return false;
      const double number = value.asDouble();
      return (!domain.min || number >= *domain.min) && (!domain.max || number <= *domain.max);
    }
    case Domain::Type::boolean: return value.isBool();
    case Domain::Type::fracKey: return value.isString() && isOrderKey(value.asString());
    case Domain::Type::stamp: return value.isString() && parseHlc(value.asString()).has_value();
    case Domain::Type::id: return value.isString();
    case Domain::Type::json: return true;
    case Domain::Type::array: {
      if (!value.isArray()) return false;
      if (domain.maxItems && static_cast<std::int64_t>(value.size()) > *domain.maxItems) return false;
      return std::all_of(value.begin(), value.end(), [&domain](const Json::Value& item) { return admits(*domain.items, item); });
    }
    case Domain::Type::object: {
      if (!value.isObject()) return false;
      auto declared = [&domain](const std::string& key) -> const Domain* {
        for (const Domain::Property& property : domain.properties) {
          if (property.name == key) return &property.domain;
        }
        return nullptr;
      };
      for (const std::string& key : value.getMemberNames()) {
        if (!declared(key)) return false;
      }
      for (const std::string& key : domain.required) {
        if (!value.isMember(key)) return false;
      }
      for (const std::string& key : value.getMemberNames()) {
        if (!admits(*declared(key), value[key])) return false;
      }
      return true;
    }
  }
  return false;
}

bool isIdOf(const Registry& registry, const TypeDef& type, const Json::Value& id) {
  if (type.identity == Identity::singleton) return id.isString() && id.asString() == *type.singletonId;
  if (!type.keyTuple.empty()) {
    if (!id.isArray() || id.size() != type.keyTuple.size()) return false;
    for (Json::ArrayIndex i = 0; i < id.size(); ++i) {
      if (!isIdOf(registry, *registry.type(type.keyTuple[i].ref), id[i])) return false;
    }
    return true;
  }
  if (type.keyRef) return isIdOf(registry, *registry.type(*type.keyRef), id);
  return id.isString() && type.idPattern && type.idPattern->matches(id.asString());
}

bool admitsValue(const Registry& registry, const FieldDef& field, const Json::Value& value) {
  switch (field.kind) {
    case FieldKind::ranked: return value.isString() && field.rank.contains(value.asString());
    case FieldKind::time: return isEpochMs(value);
    case FieldKind::serial: return isSafeInteger(value) && value.asDouble() >= 1;
    case FieldKind::text: return value.isString();
    default: break;
  }
  if (field.ref && !value.isNull() && !isIdOf(registry, *registry.type(*field.ref), value)) return false;
  if (field.ref && value.isNull() && !(field.domain && field.domain->nullable)) return false;
  if (field.domain && !admits(*field.domain, value)) return false;
  if (!value.isNull() && !withinBounds(field.bounds, value)) return false;
  return !(field.quantum && isNumber(value) && !field.quantum->holds(value.asDouble()));
}

bool admitsArgument(const Registry& registry, const ArgDef& arg, const Json::Value& value) {
  if (arg.type == ArgType::time || arg.type == ArgType::instant) return isEpochMs(value);
  if (arg.type == ArgType::ref) return isIdOf(registry, *registry.type(*arg.ref), value);
  return !arg.domain || admits(*arg.domain, value);
}

Shaped shapeIntent(const Registry& registry, const Json::Value& wire, const Sender& sender, Ms serverNow, Ms maxSkewMs) {
  const std::optional<ScopeKey> scope =
      wire.isObject() && wire["scope"].isString() ? resolve(registry, wire["scope"].asString(), sender.account) : std::nullopt;
  if (!scope) invalid();
  requireKeys(wire, {"n", "scope", "d", "guard", "cmd", "gestureId"});
  if (holdsNul(wire)) invalid();
  const Ms bound = serverNow + maxSkewMs;
  Intent intent{.scope = wire["scope"].asString()};

  const Json::Value& deltas = wire["d"];
  if (!deltas.isNull() && !deltas.isArray()) invalid();
  if (deltas.empty() && !wire.isMember("cmd")) invalid();
  std::set<std::string> records;
  for (const Json::Value& delta : deltas) {
    intent.d.push_back(deltaOf(registry, *scope, delta, sender));
    if (!records.insert(intent.d.back().t + "\n" + intent.d.back().id.key()).second) invalid();
  }
  const Json::Value& guards = wire["guard"];
  if (!guards.isNull() && !guards.isArray()) invalid();
  for (const Json::Value& guard : guards) intent.guard.push_back(guardOf(registry, *scope, guard));
  if (wire.isMember("cmd")) intent.cmd = commandOf(registry, *scope, wire["cmd"], bound);
  if (wire.isMember("gestureId")) {
    if (!wire["gestureId"].isString()) invalid();
    intent.gestureId = wire["gestureId"].asString();
  }

  for (const Delta& delta : intent.d) {
    const TypeDef& type = *registry.type(delta.t);
    for (const auto& [name, reg] : delta.lattice.f) {
      if (!admitsValue(registry, *type.field(name), reg.value)) invalid();
    }
  }
  for (const Delta& delta : intent.d) {
    for (const Stamp& stamp : stampsOf(delta)) {
      if (stamp.physicalMs > bound) throw Refusal(code::clockSkew);
    }
  }
  clampTimes(registry, intent, serverNow, bound);
  return Shaped{*scope, std::move(intent)};
}

}
