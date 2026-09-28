#include "platform/domain/sync/Shape.h"

#include "platform/domain/sync/Identity.h"
#include "platform/domain/sync/Jcs.h"

#include <algorithm>
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
  if (!registry.isIdOf(type, id)) invalid();
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

// §2.4's whole put: a delta of a wholePut type carries a life, and an alive one carries every client-written
// lattice field, every register at the life's stamp (a server origin's null alike).
bool isWhole(const TypeDef& type, const Delta& delta) {
  const std::optional<Life>& life = delta.lattice.life;
  if (!life) return false;
  if (!life->alive()) return true;
  const bool everyClientField = std::all_of(type.fields.begin(), type.fields.end(), [&delta](const auto& entry) {
    const FieldDef& field = entry.second;
    return field.writer != Writer::client || !field.isLattice() || delta.lattice.f.contains(field.name);
  });
  const bool oneStamp =
      std::all_of(delta.lattice.f.begin(), delta.lattice.f.end(), [&life](const auto& entry) { return entry.second.stamp == life->stamp; });
  return everyClientField && oneStamp;
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

  if (type.wholePut && !isWhole(type, delta)) invalid();
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
    if (!registry.admitsArgument(arg, args[name])) invalid();
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
      if (!registry.admitsValue(*type.field(name), reg.value)) invalid();
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
