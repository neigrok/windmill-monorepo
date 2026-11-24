#include "platform/domain/sync/Restore.h"

#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <map>
#include <set>

namespace wm::sync {

namespace {

constexpr std::int64_t kMaxSafe = 9'007'199'254'740'991;

bool exactKeys(const Json::Value& value, const std::vector<std::string>& keys, const std::vector<std::string>& optional = {}) {
  if (!value.isObject()) return false;
  for (const std::string& key : keys) {
    if (!value.isMember(key)) return false;
  }
  for (const std::string& name : value.getMemberNames()) {
    if (std::find(keys.begin(), keys.end(), name) == keys.end() && std::find(optional.begin(), optional.end(), name) == optional.end()) return false;
  }
  return true;
}

bool isSeq(const Json::Value& value) {
  return value.isIntegral() && value.asLargestInt() >= 0 && value.asLargestInt() <= kMaxSafe;
}

bool isStampText(const Json::Value& value) {
  if (!value.isString()) return false;
  const std::optional<Hlc> stamp = parseHlc(value.asString());
  return stamp && stamp->isSet();
}

bool slotShaped(const Json::Value& slot) {
  if (!slot.isObject() || !slot["kind"].isString()) return false;
  const std::string kind = slot["kind"].asString();
  if (kind == "born" || kind == "life") return exactKeys(slot, {"kind"});
  if (kind == "field" || kind == "text") return exactKeys(slot, {"kind", "name"}) && slot["name"].isString();
  return false;
}

// A slot a generic restore writes back: a client lww register, a client text, or the life of a keyed type
// with life or a revivable type. Never born.
bool restorable(const TypeDef& type, const Json::Value& slot) {
  if (!slotShaped(slot)) return false;
  const std::string kind = slot["kind"].asString();
  if (kind == "born") return false;
  if (kind == "life") return type.life && (type.identity == Identity::keyed || type.revivable);
  const FieldDef* field = type.field(slot["name"].asString());
  if (!field || field->writer != Writer::client) return false;
  return kind == "field" ? field->kind == FieldKind::lww : field->kind == FieldKind::text;
}

bool creatable(const TypeDef& type) {
  return type.life && !type.governsTree && !type.wholePut;
}

// A keyed record's life brought back alive: its death kept no field (G1), so its restore carries the record's values.
bool revivesKeyed(const TypeDef& type, const Json::Value& slot, const Json::Value& before) {
  return type.identity == Identity::keyed && slot["kind"] == "life" && before == "alive";
}

bool textWithin(const FieldDef& field, const Json::Value& text) {
  if (!text.isString()) return false;
  return !field.bounds || !field.bounds->max || lengthIn(field.bounds->unit, text.asString()) <= static_cast<std::size_t>(*field.bounds->max);
}

bool logicalValue(const Registry& registry, const TypeDef& type, const Json::Value& slot, const Json::Value& value) {
  const std::string kind = slot["kind"].asString();
  if (kind == "life") return value.isString() && (value.asString() == "alive" || value.asString() == "dead");
  const FieldDef& field = *type.field(slot["name"].asString());
  if (kind == "text") return textWithin(field, value);
  return registry.admitsValue(field, value);
}

bool versionShaped(const Json::Value& slot, const Json::Value& version) {
  if (slot["kind"].asString() == "text")
    return exactKeys(version, {"kind", "revision"}) && version["kind"] == "text" && isSeq(version["revision"]) && version["revision"].asLargestInt() > 0;
  return exactKeys(version, {"kind", "stamp"}) && version["kind"] == "stamp" && isStampText(version["stamp"]);
}

std::string slotOrderKey(const Json::Value& slot) {
  const std::string kind = slot["kind"].asString();
  if (kind == "born") return "0";
  if (kind == "life") return "1";
  return (kind == "field" ? "2" : "3") + slot["name"].asString();
}

bool footprintShaped(const TypeDef& type, const Json::Value& footprint) {
  if (!footprint.isArray() || footprint.empty()) return false;
  std::optional<std::string> previous;
  for (const Json::Value& item : footprint) {
    if (!exactKeys(item, {"slot", "version"}) || !slotShaped(item["slot"]) || !versionShaped(item["slot"], item["version"])) return false;
    const std::string kind = item["slot"]["kind"].asString();
    const bool hasBorn = type.identity == Identity::minted || type.identity == Identity::derived;
    if (kind == "born" && !hasBorn) return false;
    if (kind == "life" && !type.life) return false;
    if (kind == "field" || kind == "text") {
      const FieldDef* field = type.field(item["slot"]["name"].asString());
      if (!field || (kind == "text") != (field->kind == FieldKind::text) || field->kind == FieldKind::serial) return false;
    }
    const std::string key = slotOrderKey(item["slot"]);
    if (previous && *previous >= key) return false;
    previous = key;
  }
  return true;
}

// The values a create, or a keyed record's revival, writes: client lww, fww, const or time fields and client texts.
bool admitsValues(const Registry& registry, const TypeDef& type, const Json::Value& values) {
  if (!exactKeys(values, {}, {"f", "x"})) return false;
  if (values.isMember("f")) {
    if (!values["f"].isObject()) return false;
    for (const std::string& name : values["f"].getMemberNames()) {
      const FieldDef* field = type.field(name);
      const bool clientValue = field && field->writer == Writer::client
          && (field->kind == FieldKind::lww || field->kind == FieldKind::fww || field->kind == FieldKind::const_ || field->kind == FieldKind::time);
      if (!clientValue || !registry.admitsValue(*field, values["f"][name])) return false;
    }
  }
  if (values.isMember("x")) {
    if (!values["x"].isObject()) return false;
    for (const std::string& name : values["x"].getMemberNames()) {
      const FieldDef* field = type.field(name);
      if (!field || field->kind != FieldKind::text || field->writer != Writer::client || !textWithin(*field, values["x"][name])) return false;
    }
  }
  return true;
}

// Writes a create's or a keyed revival's values into `delta` under the server stamp, each text onto an empty head.
void writeValues(Delta& delta, const Json::Value& values) {
  if (values.isMember("f")) {
    for (const std::string& name : values["f"].getMemberNames()) delta.lattice.f.insert_or_assign(name, Reg(values["f"][name], Stamp{}));
  }
  if (values.isMember("x")) {
    for (const std::string& name : values["x"].getMemberNames()) delta.x.insert_or_assign(name, TextWrite{.text = values["x"][name].asString(), .base = TextBase{.rev = 0}});
  }
}

// §2.4's ScopeRef families, a tree or overlay naming a governing id: the registry scope `ref` names, or nothing.
std::optional<RegistryScope> scopeOfRef(const Registry& registry, const std::string& ref) {
  const TypeDef* governing = registry.governingType();
  const auto governed = [&](const std::string& tree) { return governing && registry.isIdOf(*governing, Json::Value(tree)); };
  if (ref.starts_with("tree/")) {
    const std::string tree = ref.substr(5);
    if (tree.find('/') != std::string::npos || !governed(tree)) return std::nullopt;
    return RegistryScope{ScopeKind::tree, ""};
  }
  if (ref.starts_with("self/overlay/")) {
    const std::string tree = ref.substr(13);
    if (tree.find('/') != std::string::npos || !governed(tree)) return std::nullopt;
    return RegistryScope{ScopeKind::overlay, ""};
  }
  if (ref.starts_with("self/")) {
    const std::string product = ref.substr(5);
    if (!registry.products().contains(product)) return std::nullopt;
    return RegistryScope{ScopeKind::product, product};
  }
  return std::nullopt;
}

bool addressOf(const Registry& registry, const Json::Value& address, bool withSlot) {
  if (!exactKeys(address, withSlot ? std::vector<std::string>{"scope", "t", "id", "slot"} : std::vector<std::string>{"scope", "t", "id"})) return false;
  if (!address["scope"].isString() || !address["t"].isString()) return false;
  const TypeDef* type = registry.type(address["t"].asString());
  const std::optional<RegistryScope> scope = scopeOfRef(registry, address["scope"].asString());
  if (!type || !scope || !(type->scope == *scope) || !registry.isIdOf(*type, address["id"])) return false;
  return !withSlot || slotShaped(address["slot"]);
}

}

bool admitsRestoreArguments(const Registry& registry, const CommandDef& command, const Json::Value& args) {
  if (!exactKeys(args, {"expectedEpoch", "operations"})) return false;
  if (!args["expectedEpoch"].isString() || args["expectedEpoch"].asString().empty()) return false;
  const Json::Value& operations = args["operations"];
  if (!operations.isArray() || operations.empty()) return false;
  std::set<std::string> slots;
  for (const Json::Value& op : operations) {
    if (!op.isObject() || !op["t"].isString() || !op["kind"].isString()) return false;
    const std::string t = op["t"].asString();
    const TypeDef* type = registry.type(t);
    if (!type || std::find(command.predicts.begin(), command.predicts.end(), t) == command.predicts.end()) return false;
    if (!registry.isIdOf(*type, op["id"])) return false;
    const std::string kind = op["kind"].asString();
    if (kind == "field") {
      if (!exactKeys(op, {"kind", "t", "id", "slot", "expected", "before"}, {"values"})) return false;
      if (!restorable(*type, op["slot"]) || !logicalValue(registry, *type, op["slot"], op["before"])) return false;
      if (op.isMember("values") && (!revivesKeyed(*type, op["slot"], op["before"]) || !admitsValues(registry, *type, op["values"]))) return false;
      const Json::Value& expected = op["expected"];
      if (expected.isObject() && expected["kind"] == "absent") {
        if (!exactKeys(expected, {"kind", "born"}) || op["slot"]["kind"] == "life") return false;
        const bool hasBorn = type->identity == Identity::minted || type->identity == Identity::derived;
        if (hasBorn ? !isStampText(expected["born"]) : !expected["born"].isNull()) return false;
      } else if (!versionShaped(op["slot"], expected)) {
        return false;
      }
      if (!slots.insert(t + "\n" + jcs(op["id"]) + jcs(op["slot"])).second) return false;
    } else if (kind == "createdRecord") {
      if (!exactKeys(op, {"kind", "t", "id", "rowSeq", "footprint"})) return false;
      if (!creatable(*type) || !footprintShaped(*type, op["footprint"])) return false;
      if (!isSeq(op["rowSeq"]) || op["rowSeq"].asLargestInt() == 0) return false;
    } else if (kind == "createRecord") {
      if (!exactKeys(op, {"kind", "t", "id", "values"})) return false;
      if (!creatable(*type) || !admitsValues(registry, *type, op["values"])) return false;
    } else {
      return false;
    }
  }
  return true;
}

bool admitsEvidence(const Registry& registry, const Json::Value& evidence) {
  if (!exactKeys(evidence, {"expectedEpoch", "ownedFields", "unchangedCreatedRecords", "unchangedCreatedScopes"})) return false;
  if (!evidence["expectedEpoch"].isString() || evidence["expectedEpoch"].asString().empty()) return false;
  if (!evidence["ownedFields"].isArray() || !evidence["unchangedCreatedRecords"].isArray() || !evidence["unchangedCreatedScopes"].isArray()) return false;
  for (const Json::Value& item : evidence["ownedFields"]) {
    if (!exactKeys(item, {"target", "version"}) || !addressOf(registry, item["target"], true) || !versionShaped(item["target"]["slot"], item["version"])) return false;
  }
  for (const Json::Value& item : evidence["unchangedCreatedRecords"]) {
    if (!exactKeys(item, {"record", "rowSeq", "footprint"}) || !addressOf(registry, item["record"], false)) return false;
    if (!isSeq(item["rowSeq"]) || item["rowSeq"].asLargestInt() == 0) return false;
    if (!footprintShaped(*registry.type(item["record"]["t"].asString()), item["footprint"])) return false;
  }
  for (const Json::Value& item : evidence["unchangedCreatedScopes"]) {
    if (!exactKeys(item, {"scope", "seq"}) || !item["scope"].isString() || !isSeq(item["seq"])) return false;
    const std::optional<RegistryScope> scope = scopeOfRef(registry, item["scope"].asString());
    if (!scope || scope->kind == ScopeKind::product) return false;
  }
  return true;
}

Json::Value versionIn(const std::optional<Row>& row, const Json::Value& slot) {
  if (!row) return Json::nullValue;
  const std::string kind = slot["kind"].asString();
  Json::Value version(Json::objectValue);
  if (kind == "text") {
    const auto text = row->x.find(slot["name"].asString());
    if (text == row->x.end()) return Json::nullValue;
    version["kind"] = "text";
    version["revision"] = Json::UInt64(text->second.rev);
    return version;
  }
  std::optional<Stamp> stamp;
  if (kind == "born") stamp = row->lattice.born;
  if (kind == "life" && row->lattice.life) stamp = row->lattice.life->stamp;
  if (kind == "field") {
    const auto reg = row->lattice.f.find(slot["name"].asString());
    if (reg != row->lattice.f.end()) stamp = reg->second.stamp;
  }
  if (!stamp) return Json::nullValue;
  version["kind"] = "stamp";
  version["stamp"] = toString(*stamp);
  return version;
}

Json::Value footprintOf(const Row& row) {
  Json::Value footprint(Json::arrayValue);
  auto add = [&](Json::Value slot) {
    Json::Value version = versionIn(row, slot);
    if (version.isNull()) return;
    Json::Value item(Json::objectValue);
    item["slot"] = std::move(slot);
    item["version"] = std::move(version);
    footprint.append(std::move(item));
  };
  Json::Value born(Json::objectValue);
  born["kind"] = "born";
  add(born);
  Json::Value life(Json::objectValue);
  life["kind"] = "life";
  add(life);
  for (const auto& [name, reg] : row.lattice.f) {
    Json::Value slot(Json::objectValue);
    slot["kind"] = "field";
    slot["name"] = name;
    add(slot);
  }
  for (const auto& [name, text] : row.x) {
    Json::Value slot(Json::objectValue);
    slot["kind"] = "text";
    slot["name"] = name;
    add(slot);
  }
  return footprint;
}

RestoreOutcome evaluateRestore(const Registry& registry, const RestoreReader& read, const Json::Value& args, const std::string& epoch) {
  struct Working {
    std::optional<Row> row;
    std::optional<Delta> delta;
  };
  RestoreOutcome out{.outcomes = Json::Value(Json::arrayValue)};
  std::map<std::string, Working> records;
  std::vector<std::string> order;
  auto skip = [&](Json::ArrayIndex index, const std::string& code) {
    Json::Value outcome(Json::objectValue);
    outcome["index"] = index;
    outcome["s"] = "skipped";
    outcome["code"] = code;
    out.outcomes.append(std::move(outcome));
  };
  auto applied = [&](Json::ArrayIndex index) {
    Json::Value outcome(Json::objectValue);
    outcome["index"] = index;
    outcome["s"] = "applied";
    out.outcomes.append(std::move(outcome));
  };
  const Json::Value& operations = args["operations"];
  for (Json::ArrayIndex index = 0; index < operations.size(); ++index) {
    const Json::Value& op = operations[index];
    if (args["expectedEpoch"].asString() != epoch) {
      skip(index, "epoch-changed");
      continue;
    }
    const TypeDef& type = *registry.type(op["t"].asString());
    const RecordId id(op["id"]);
    const std::string key = jcs(op["t"]) + jcs(op["id"]);
    if (!records.contains(key)) {
      records.emplace(key, Working{read.stored(type.name, id), std::nullopt});
      order.push_back(key);
    }
    Working& record = records.at(key);
    const bool hasBorn = type.identity == Identity::minted || type.identity == Identity::derived;
    auto deltaOf = [&]() -> Delta& {
      if (record.delta) return *record.delta;
      record.delta = Delta{.t = type.name, .id = id};
      if (hasBorn) record.delta->lattice.born = record.row->lattice.born;
      if (type.life && (type.identity == Identity::keyed || !record.row->alive())) record.delta->lattice.life = record.row->lattice.life;
      return *record.delta;
    };
    const std::string kind = op["kind"].asString();
    if (kind == "field") {
      const Json::Value& slot = op["slot"];
      const Json::Value& expected = op["expected"];
      if (expected["kind"] == "absent") {
        const bool sameIncarnation = record.row && (!hasBorn || (record.row->lattice.born && toString(*record.row->lattice.born) == expected["born"].asString()));
        if (!sameIncarnation || !versionIn(record.row, slot).isNull()) {
          skip(index, "version-changed");
          continue;
        }
      } else if (jcs(versionIn(record.row, slot)) != jcs(expected)) {
        skip(index, "version-changed");
        continue;
      }
      const std::string slotKind = slot["kind"].asString();
      if (slotKind != "life" && type.life && !record.row->alive() && !type.revivable && type.identity != Identity::keyed) {
        skip(index, "record-dead");
        continue;
      }
      Delta& delta = deltaOf();
      if (slotKind == "life") {
        delta.lattice.life = Life(op["before"].asString() == "alive" ? LifeState::alive : LifeState::dead, Stamp{});
        // A record found alive keeps its own fields; only a dead keyed row lacks them (G1).
        if (op.isMember("values") && !record.row->alive()) writeValues(delta, op["values"]);
      } else if (slotKind == "field") {
        delta.lattice.f.insert_or_assign(slot["name"].asString(), Reg(op["before"], Stamp{}));
      } else {
        delta.x.insert_or_assign(slot["name"].asString(), TextWrite{.text = op["before"].asString(), .base = TextBase{.rev = 0}, .replacement = true});
      }
      applied(index);
    } else if (kind == "createdRecord") {
      if (!record.row || !record.row->alive() || record.row->seq != static_cast<Seq>(op["rowSeq"].asLargestInt())
          || jcs(footprintOf(*record.row)) != jcs(op["footprint"])) {
        skip(index, "record-changed");
        continue;
      }
      deltaOf().lattice.life = Life(LifeState::dead, Stamp{});
      applied(index);
    } else {
      if (record.row || record.delta || !read.absent(type.name, id)) {
        skip(index, "record-present");
        continue;
      }
      Delta created{.t = type.name, .id = id};
      created.lattice.life = Life(LifeState::alive, Stamp{});
      if (hasBorn) created.lattice.born = Stamp{};
      writeValues(created, op["values"]);
      record.delta = std::move(created);
      applied(index);
    }
  }
  for (const std::string& key : order) {
    if (records.at(key).delta) out.deltas.push_back(*records.at(key).delta);
  }
  return out;
}

std::optional<std::string> evidenceSkip(const EvidenceReader& read, const Json::Value& evidence, const std::string& epoch) {
  if (evidence["expectedEpoch"].asString() != epoch) return "epoch-changed";
  for (const Json::Value& item : evidence["ownedFields"]) {
    const Json::Value& target = item["target"];
    const std::optional<Row> row = read.row(target["scope"].asString(), target["t"].asString(), RecordId(target["id"]));
    if (jcs(versionIn(row, target["slot"])) != jcs(item["version"])) return "version-changed";
  }
  for (const Json::Value& item : evidence["unchangedCreatedRecords"]) {
    const Json::Value& record = item["record"];
    const std::optional<Row> row = read.row(record["scope"].asString(), record["t"].asString(), RecordId(record["id"]));
    if (!row || !row->alive() || row->seq != static_cast<Seq>(item["rowSeq"].asLargestInt()) || jcs(footprintOf(*row)) != jcs(item["footprint"])) return "record-changed";
  }
  for (const Json::Value& item : evidence["unchangedCreatedScopes"]) {
    const std::optional<Seq> seq = read.seq(item["scope"].asString());
    if (!seq || *seq != static_cast<Seq>(item["seq"].asLargestInt())) return "scope-changed";
  }
  return std::nullopt;
}

Json::Value inverseDetail(const std::optional<std::string>& skip) {
  Json::Value outcome(Json::objectValue);
  outcome["index"] = 0;
  outcome["s"] = skip ? "skipped" : "applied";
  if (skip) outcome["code"] = *skip;
  Json::Value detail(Json::objectValue);
  detail["inverse"]["outcomes"].append(std::move(outcome));
  return detail;
}

bool reportsInverseOutcome(const Json::Value& detail) {
  if (!detail.isObject() || !detail["inverse"].isObject() || !detail["inverse"]["outcomes"].isArray() || detail["inverse"]["outcomes"].size() != 1) return false;
  const Json::Value& outcome = detail["inverse"]["outcomes"][0];
  if (!outcome.isObject() || !outcome["index"].isIntegral() || outcome["index"].asInt64() != 0 || !outcome["s"].isString()) return false;
  if (outcome["s"].asString() == "applied") return outcome.size() == 2;
  return outcome["s"].asString() == "skipped" && outcome.size() == 3 && outcome["code"].isString();
}

}
