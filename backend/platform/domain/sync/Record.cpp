#include "platform/domain/sync/Record.h"

#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <utility>

namespace wm::sync {

namespace {

std::uint64_t unsignedOf(const Json::Value& wire, const char* part) {
  if (!wire.isUInt64()) throw WireError(std::string("a row's ") + part + " is an unsigned integer");
  return wire.asUInt64();
}

bool holdsValue(const Row& row, const std::string& field) {
  if (const auto text = row.x.find(field); text != row.x.end()) return !text->second.text.empty();
  const auto reg = row.lattice.f.find(field);
  if (reg == row.lattice.f.end()) return false;
  const Json::Value& value = reg->second.value;
  return !value.isNull() && !(value.isString() && value.asString().empty());
}

}

Stamp stampOf(const Json::Value& wire) {
  if (!wire.isString()) throw WireError("a stamp is text");
  std::optional<Stamp> stamp = parseHlc(wire.asString());
  if (!stamp) throw WireError("a stamp is ms:counter:actor");
  return std::move(*stamp);
}

RecordId::RecordId(Json::Value value) : value_(std::move(value)), key_(jcs(value_)) {}

RecordId RecordId::fromColumn(const std::string& column, bool tuple) {
  if (!tuple) return RecordId(column);
  return RecordId(parseJson(column));
}

std::string RecordId::column() const {
  return value_.isString() ? value_.asString() : key_;
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

Json::Value TextVal::toJson() const {
  Json::Value wire(Json::objectValue);
  wire["text"] = text;
  wire["rev"] = Json::UInt64(rev);
  wire["merged"] = merged;
  return wire;
}

Row::Row(const Json::Value& wire) : lattice(wire) {
  if (!wire["t"].isString() || !wire.isMember("id")) throw WireError("a row has a type and an id");
  t = wire["t"].asString();
  id = RecordId(wire["id"]);
  for (const std::string& name : wire["x"].getMemberNames()) {
    const Json::Value& text = wire["x"][name];
    if (!text["text"].isString() || !text["merged"].isBool()) throw WireError("a row's text is {text, rev, merged}");
    x.emplace(name, TextVal{text["text"].asString(), unsignedOf(text["rev"], "rev"), text["merged"].asBool()});
  }
  for (const std::string& name : wire["v"].getMemberNames()) v.emplace(name, wire["v"][name]);
  seq = unsignedOf(wire["seq"], "seq");
  if (wire.isMember("rc")) rc = unsignedOf(wire["rc"], "rc");
  if (wire.isMember("ru")) ru = unsignedOf(wire["ru"], "ru");
}

Json::Value Row::toJson() const {
  Json::Value wire = lattice.toJson();
  wire["t"] = t;
  wire["id"] = id.json();
  if (!x.empty()) {
    Json::Value& texts = wire["x"] = Json::Value(Json::objectValue);
    for (const auto& [name, text] : x) texts[name] = text.toJson();
  }
  if (!v.empty()) {
    Json::Value& serials = wire["v"] = Json::Value(Json::objectValue);
    for (const auto& [name, value] : v) serials[name] = value;
  }
  wire["seq"] = Json::UInt64(seq);
  wire["rc"] = Json::UInt64(rc);
  wire["ru"] = Json::UInt64(ru);
  return wire;
}

Json::Value Row::thin() const {
  Json::Value wire(Json::objectValue);
  wire["t"] = t;
  wire["id"] = id.json();
  if (lattice.life) wire["life"] = lattice.life->toJson();
  if (lattice.born) wire["born"] = toString(*lattice.born);
  wire["seq"] = Json::UInt64(seq);
  return wire;
}

bool visible(const TypeDef& type, const Row& row) {
  if (type.identity == Identity::singleton) return true;
  if (type.life) return row.lattice.life && row.lattice.life->alive();
  if (type.visibleWhen.empty()) return !row.lattice.f.empty() || !row.x.empty();
  return std::any_of(type.visibleWhen.begin(), type.visibleWhen.end(),
                     [&row](const std::string& field) { return holdsValue(row, field); });
}

bool Delta::unminted() const {
  if (lattice.life && !lattice.life->stamp.isSet()) return true;
  if (lattice.born && !lattice.born->isSet()) return true;
  return std::any_of(lattice.f.begin(), lattice.f.end(), [](const auto& entry) { return !entry.second.stamp.isSet(); });
}

}
