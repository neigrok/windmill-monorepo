#include "platform/domain/sync/Record.h"

#include <utility>

namespace wm::sync {

Stamp stampOf(const Json::Value& wire) {
  if (!wire.isString()) throw WireError("a stamp is text");
  std::optional<Stamp> stamp = parseHlc(wire.asString());
  if (!stamp) throw WireError("a stamp is ms:counter:actor");
  return std::move(*stamp);
}

Life::Life(LifeState state, Stamp stamp) : state(state), stamp(std::move(stamp)) {}

Life::Life(const Json::Value& wire) {
  if (!wire.isArray() || wire.size() != 2 || !wire[0].isString()) throw WireError("a life is [\"alive\"|\"dead\", stamp]");
  const std::string word = wire[0].asString();
  if (word != "alive" && word != "dead") throw WireError("a life is [\"alive\"|\"dead\", stamp]");
  state = word == "alive" ? LifeState::alive : LifeState::dead;
  stamp = stampOf(wire[1]);
}

Json::Value Life::toJson() const {
  Json::Value wire(Json::arrayValue);
  wire.append(state == LifeState::alive ? "alive" : "dead");
  wire.append(toString(stamp));
  return wire;
}

Reg::Reg(Json::Value value, Stamp stamp) : value(std::move(value)), stamp(std::move(stamp)) {}

Reg::Reg(const Json::Value& wire) {
  if (!wire.isArray() || wire.size() != 2) throw WireError("a register is [value, stamp]");
  value = wire[0];
  stamp = stampOf(wire[1]);
}

Json::Value Reg::toJson() const {
  Json::Value wire(Json::arrayValue);
  wire.append(value);
  wire.append(toString(stamp));
  return wire;
}

LatticeRecord::LatticeRecord(const Json::Value& record) {
  if (!record.isObject()) throw WireError("a record is an object");
  if (record.isMember("life")) life = Life(record["life"]);
  if (record.isMember("born")) born = stampOf(record["born"]);
  if (!record.isMember("f")) return;
  const Json::Value& registers = record["f"];
  if (!registers.isObject()) throw WireError("a record's f is an object of registers");
  for (const std::string& name : registers.getMemberNames()) f.emplace(name, Reg(registers[name]));
}

Json::Value LatticeRecord::toJson() const {
  Json::Value record(Json::objectValue);
  if (life) record["life"] = life->toJson();
  if (born) record["born"] = toString(*born);
  if (f.empty()) return record;
  Json::Value& registers = record["f"] = Json::Value(Json::objectValue);
  for (const auto& [name, reg] : f) registers[name] = reg.toJson();
  return record;
}

}
