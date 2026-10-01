#include "platform/domain/sync/Admit.h"

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Lattice.h"
#include "platform/domain/sync/Shape.h"
#include "platform/domain/sync/TextMerge.h"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace wm::sync {

namespace {

Json::Value comparable(const std::optional<Row>& row) {
  if (!row) return Json::Value(Json::nullValue);
  Json::Value out = row->lattice.toJson();
  if (!row->x.empty()) {
    Json::Value& texts = out["x"] = Json::Value(Json::objectValue);
    for (const auto& [name, text] : row->x) {
      texts[name]["text"] = text.text;
      texts[name]["merged"] = text.merged;
    }
  }
  if (!row->v.empty()) {
    Json::Value& serials = out["v"] = Json::Value(Json::objectValue);
    for (const auto& [name, value] : row->v) serials[name] = value;
  }
  return out;
}

Digest256 hashOf(const std::optional<Row>& row) {
  return row ? rowHash(row->toJson()) : Digest256{};
}

const FieldDef* parentFieldOf(const TypeDef& type) {
  for (const auto& [name, field] : type.fields) {
    if (field.parent) return &field;
  }
  return nullptr;
}

Json::Value valueOf(const LatticeRecord& lattice, const std::string& field) {
  const auto reg = lattice.f.find(field);
  return reg == lattice.f.end() ? Json::Value(Json::nullValue) : reg->second.value;
}

void observeRegisters(HlcClock& clock, const Delta& written, const LatticeRecord& other) {
  if (written.lattice.life && other.life) clock.observe(other.life->stamp);
  for (const auto& [name, reg] : written.lattice.f) {
    if (const auto found = other.f.find(name); found != other.f.end()) clock.observe(found->second.stamp);
  }
}

void fillUnset(Stamp& slot, const Stamp& stamp) {
  if (!slot.isSet()) slot = stamp;
}

}

Locked Locked::compose(const TypeDef& type, const ScopeKey& scope, const RecordId& id, std::optional<Row> typed, std::optional<Row> spent,
                       bool elsewhere, const std::optional<std::optional<std::string>>& governed) {
  Locked locked;
  locked.stored = typed ? typed : spent;
  locked.typed = std::move(typed);
  if (locked.stored) {
    locked.state = IdState{locked.stored->alive() ? IdState::Kind::alive : IdState::Kind::dead, locked.stored->lattice.born};
    return locked;
  }
  if (type.idSpace == IdSpace::global && elsewhere) {
    locked.state.kind = IdState::Kind::foreign;
    return locked;
  }
  const std::string governedBy = scope.text() + "#" + type.name + "#" + id.column();
  if (type.governsTree && governed && *governed != governedBy) locked.state.kind = IdState::Kind::foreign;
  return locked;
}

Row spentRow(const std::string& t, const RecordId& id, const std::optional<Stamp>& born, const Stamp& lifeStamp, Seq seq) {
  Row row{t, id};
  row.lattice.life = Life(LifeState::dead, lifeStamp);
  row.lattice.born = born;
  row.seq = seq;
  return row;
}

bool Change::changed() const {
  return jcs(comparable(stored)) != jcs(comparable(after));
}

Row Change::storedAt(Seq seq, Ms serverNow) const {
  Row row = after;
  for (auto& [name, text] : row.x) {
    if (text.rev == 0) text.rev = seq;
  }
  row.seq = seq;
  row.rc = typed ? typed->rc : serverNow;
  row.ru = serverNow;
  return row;
}

std::string SerialWanted::key() const {
  Json::Value wire(Json::arrayValue);
  wire.append(scope.text());
  wire.append(type->name);
  wire.append(field);
  Json::Value& values = wire.append(Json::Value(Json::objectValue));
  for (const auto& [name, value] : match) values[name] = value;
  return jcs(wire);
}

ChangeSet::ChangeSet(const Registry& registry, ScopeKey intentScope, Ms serverNow, const Limits& limits)
    : registry_(registry), intentScope_(std::move(intentScope)), serverNow_(serverNow), limits_(limits) {}

void ChangeSet::admit(const TypeDef& type, const ScopeKey& scope, Delta delta, Source source, const Locked& locked) {
  const Op op = opOf(type, delta);
  IdState state = locked.state;
  if (source == Source::check) {
    if (const Change* joined = find(RecordRef{scope, delta.t, delta.id})) state = IdState{joined->after.alive() ? IdState::Kind::alive : IdState::Kind::dead, joined->after.lattice.born};
  }
  const Decision decision = decide(type, op, state, delta.lattice.born);
  if (decision.verdict == Decision::Verdict::refuse) throw Refusal(decision.code);
  if (decision.verdict == Decision::Verdict::ok) return;
  if (source == Source::client && locked.stored) {
    for (const auto& [name, reg] : delta.lattice.f) {
      const FieldKind kind = type.field(name)->kind;
      if (kind != FieldKind::const_ && kind != FieldKind::time) continue;
      const auto current = locked.stored->lattice.f.find(name);
      if (current == locked.stored->lattice.f.end()) continue;
      if (current->second.stamp != reg.stamp && jcs(current->second.value) != jcs(reg.value)) throw Refusal(code::invalid);
    }
  }
  queued_.push_back(Queued{&type, scope, std::move(delta), op, source, locked});
}

void ChangeSet::mint(HlcClock& clock) {
  std::vector<Queued*> unminted;
  for (Queued& queued : queued_) {
    if (queued.source != Source::client && queued.delta.unminted()) unminted.push_back(&queued);
  }
  auto entryUnset = [](const WriteEntry& entry) {
    if (entry.born && !entry.born->isSet()) return true;
    return std::any_of(entry.f.begin(), entry.f.end(), [](const auto& field) { return !field.second.isSet(); });
  };
  const bool mapNeeds = !mapStamped_ && write_ && std::any_of(write_->begin(), write_->end(), entryUnset);
  if (unminted.empty() && !mapNeeds) return;

  for (const Queued* server : unminted) {
    if (server->locked.stored) observeRegisters(clock, server->delta, server->locked.stored->lattice);
    for (const Queued& client : queued_) {
      const bool sameRecord = client.scope == server->scope && client.delta.t == server->delta.t && client.delta.id == server->delta.id;
      if (client.source == Source::client && sameRecord) observeRegisters(clock, server->delta, client.delta.lattice);
    }
  }
  const Stamp stamp = clock.tick(serverNow_);
  for (Queued* server : unminted) {
    LatticeRecord& lattice = server->delta.lattice;
    if (lattice.life) fillUnset(lattice.life->stamp, stamp);
    if (lattice.born) fillUnset(*lattice.born, stamp);
    for (auto& [name, reg] : lattice.f) fillUnset(reg.stamp, stamp);
  }
  if (mapStamped_) return;
  mapStamped_ = true;
  if (!write_) return;
  for (WriteEntry& entry : *write_) {
    if (entry.born) fillUnset(*entry.born, stamp);
    for (auto& [name, fieldStamp] : entry.f) fillUnset(fieldStamp, stamp);
  }
}

std::set<RevisionWanted> ChangeSet::revisionsWanted() const {
  std::set<RevisionWanted> wanted;
  for (const Queued& queued : queued_) {
    for (const auto& [name, write] : queued.delta.x) {
      if (!write.base.rev) continue;
      Seq headRev = 0;
      if (queued.locked.stored) {
        if (const auto head = queued.locked.stored->x.find(name); head != queued.locked.stored->x.end()) headRev = head->second.rev;
      }
      if (*write.base.rev != headRev) wanted.insert(RevisionWanted{RecordRef{queued.scope, queued.delta.t, queued.delta.id}, name, *write.base.rev});
    }
  }
  return wanted;
}

void ChangeSet::join(const std::map<RevisionWanted, std::optional<std::string>>& revisions, const std::map<std::string, Seq>& scopeSeqs) {
  changes_.clear();
  positions_.clear();
  for (const Queued& queued : queued_) {
    if (queued.delta.unminted()) throw std::logic_error("a delta reached the join with a stamp step 9 never minted");
    const RecordRef key{queued.scope, queued.delta.t, queued.delta.id};
    Change* change = find(key);
    const std::optional<Row> before = change ? std::optional<Row>(change->after) : queued.locked.stored;

    Row after{queued.delta.t, queued.delta.id};
    after.lattice = joinRecord(*queued.type, before ? before->lattice : LatticeRecord{}, queued.delta.lattice);
    if (before) {
      after.x = before->x;
      after.v = before->v;
    }
    for (const auto& [name, value] : queued.delta.v) after.v[name] = value;

    std::vector<TextRevision> superseded;
    for (const auto& [name, write] : queued.delta.x) {
      const FieldDef& field = *queued.type->field(name);
      const auto stored = before ? before->x.find(name) : after.x.end();
      const TextVal head = before && stored != before->x.end() ? stored->second : TextVal{};
      std::optional<std::string> revision;
      if (const auto loaded = revisions.find(RevisionWanted{key, name, write.base.rev.value_or(0)}); loaded != revisions.end()) revision = loaded->second;
      const std::optional<TextMerge> merge = mergeText(head.text, head.rev, write.base, write.text, revision, limits_.mergeWorkCells);
      if (!merge) throw Refusal(code::baseUnknown);
      if (static_cast<std::int64_t>(lengthIn(field.bounds->unit, merge->text)) > *field.bounds->max) throw Refusal(code::tooLarge);
      const bool merged = mergedFlag(head.merged, head.text, *merge);
      if (merge->text == head.text && merged == head.merged) continue;
      after.x[name] = TextVal{merge->text, 0, merged};
      if (head.rev > 0) superseded.push_back(TextRevision{name, head.rev, head.text});
    }
    const LatticeRecord joined = after.lattice;
    if (!after.alive() && !queued.type->revivable) {
      after.lattice.f.clear();
      after.x.clear();
      after.v.clear();
    }

    if (!change) {
      const bool isNew = queued.locked.state.kind == IdState::Kind::none || queued.locked.state.kind == IdState::Kind::foreign;
      positions_.emplace(key, changes_.size());
      change = &changes_.emplace_back(Change{.type = queued.type,
                                             .scope = queued.scope,
                                             .stored = queued.locked.stored,
                                             .typed = queued.locked.typed,
                                             .isNew = isNew});
    }
    if (queued.op == Op::create) change->createdBy.push_back(queued.source);
    change->after = std::move(after);
    change->joined = joined;
    change->revisions.insert(change->revisions.end(), superseded.begin(), superseded.end());
    if (!change->changed()) continue;
    const auto scopeSeq = scopeSeqs.find(queued.scope.text());
    const Seq next = (scopeSeq == scopeSeqs.end() ? 0 : scopeSeq->second) + 1;
    if (jcs(change->storedAt(next, serverNow_).toJson()).size() > limits_.maxRecordBytes) throw Refusal(code::tooLarge);
  }
}

const Change* ChangeSet::find(const RecordRef& key) const {
  const auto position = positions_.find(key);
  return position == positions_.end() ? nullptr : &changes_[position->second];
}

Change* ChangeSet::find(const RecordRef& key) {
  const auto position = positions_.find(key);
  return position == positions_.end() ? nullptr : &changes_[position->second];
}

std::set<RecordRef> ChangeSet::parentsWanted() const {
  std::set<RecordRef> wanted;
  for (const Queued& queued : queued_) {
    if (queued.op != Op::create && queued.op != Op::update) continue;
    const FieldDef* parent = parentFieldOf(*queued.type);
    if (!parent) continue;
    const Change* record = find(RecordRef{queued.scope, queued.delta.t, queued.delta.id});
    const Json::Value parentId = valueOf(record->joined, parent->name);
    if (parentId.isNull()) continue;
    const RecordRef key{queued.scope, *parent->ref, RecordId(parentId)};
    if (!find(key)) wanted.insert(key);
  }
  return wanted;
}

void ChangeSet::checkParents(const std::map<RecordRef, std::optional<Row>>& storedParents) const {
  for (const Queued& queued : queued_) {
    if (queued.op != Op::create && queued.op != Op::update) continue;
    const FieldDef* parent = parentFieldOf(*queued.type);
    if (!parent) continue;
    const Change* record = find(RecordRef{queued.scope, queued.delta.t, queued.delta.id});
    const Json::Value parentId = valueOf(record->joined, parent->name);
    if (parentId.isNull()) throw Refusal(code::parentDead);
    const RecordRef key{queued.scope, *parent->ref, RecordId(parentId)};
    std::optional<Row> row;
    if (const Change* joined = find(key)) row = joined->after;
    else if (const auto stored = storedParents.find(key); stored != storedParents.end()) row = stored->second;
    if (!row || !row->alive()) throw Refusal(code::parentDead);
  }
}

std::vector<SerialWanted> ChangeSet::serialsWanted() const {
  std::vector<SerialWanted> wanted;
  for (const Change& change : changes_) {
    if (!change.isNew) continue;
    for (const auto& [name, field] : change.type->fields) {
      if (field.kind != FieldKind::serial || change.after.v.contains(name)) continue;
      SerialWanted serial{change.scope, change.type, name, {}};
      for (const std::string& next : field.serialNext) serial.match[next] = valueOf(change.after.lattice, next);
      wanted.push_back(std::move(serial));
    }
  }
  return wanted;
}

void ChangeSet::assignSerials(const std::map<std::string, std::optional<std::int64_t>>& storedMaxima) {
  std::vector<const Row*> numbered;
  for (Change& change : changes_) {
    if (!change.isNew) continue;
    for (const auto& [name, field] : change.type->fields) {
      if (field.kind != FieldKind::serial || change.after.v.contains(name)) continue;
      SerialWanted serial{change.scope, change.type, name, {}};
      for (const std::string& next : field.serialNext) serial.match[next] = valueOf(change.after.lattice, next);
      std::int64_t highest = storedMaxima.at(serial.key()).value_or(0);
      for (const Row* peer : numbered) {
        const bool sameRun = std::all_of(field.serialNext.begin(), field.serialNext.end(),
                                         [&](const std::string& next) { return jcs(valueOf(peer->lattice, next)) == jcs(valueOf(change.after.lattice, next)); });
        if (peer->t != change.after.t || !peer->alive() || peer->id == change.after.id || !sameRun) continue;
        if (const auto value = peer->v.find(name); value != peer->v.end()) highest = std::max(highest, value->second.asInt64());
      }
      change.after.v[name] = Json::Int64(highest + 1);
    }
    numbered.push_back(&change.after);
  }
}

void ChangeSet::checkCaps(const std::map<std::string, std::map<std::string, std::int64_t>>& counters) {
  auto stored = [&counters](const std::string& scope, const std::string& type) -> std::int64_t {
    const auto inScope = counters.find(scope);
    if (inScope == counters.end()) return 0;
    const auto count = inScope->second.find(type);
    return count == inScope->second.end() ? 0 : count->second;
  };
  counts_.clear();
  for (const Change& change : changes_) {
    if (!change.type->cap) continue;
    auto& counts = counts_[change.scope.text()];
    const auto [count, fresh] = counts.try_emplace(change.type->name, stored(change.scope.text(), change.type->name));
    count->second += (change.after.alive() ? 1 : 0) - (change.wasAlive() ? 1 : 0);
  }
  for (const auto& [scope, counts] : counts_) {
    for (const auto& [type, after] : counts) {
      const std::int64_t cap = *registry_.type(type)->cap;
      if (after > cap && after > stored(scope, type)) {
        Json::Value detail(Json::objectValue);
        detail["type"] = type;
        detail["cap"] = Json::Int64(cap);
        throw Refusal(code::cap, detail);
      }
    }
  }
}

std::optional<ScopeWrite> ChangeSet::stage(const ScopeKey& scope, Seq seq, const std::map<std::string, std::int64_t>& counters,
                                           const Digest256& digest, bool open, const std::optional<Opening>& opening) const {
  ScopeWrite write{.scope = scope, .seq = seq + 1, .counters = counters, .digest = digest, .open = open};
  if (const auto counts = counts_.find(scope.text()); counts != counts_.end()) {
    for (const auto& [type, count] : counts->second) write.counters[type] = count;
  }
  for (const Change& change : changes_) {
    if (change.scope != scope || !change.changed()) continue;
    const Row after = change.storedAt(write.seq, serverNow_);
    const TypeDef& type = *change.type;
    std::optional<Row> typedAfter;
    if (!after.alive() && !type.revivable && type.deadRows == DeadRows::spent) {
      write.spentAdded.push_back(spentRow(after.t, after.id, after.lattice.born, after.lattice.life->stamp, write.seq));
      write.frameRows.push_back(after.thin());
    } else {
      if (!change.typed && change.stored) write.spentRemoved.emplace_back(after.t, after.id);
      write.frameRows.push_back(after.alive() ? after.toJson() : after.thin());
      typedAfter = after;
    }
    write.digest = write.digest - hashOf(change.typed) + hashOf(typedAfter);
    if (opening && after.t == opening->type) write.open = opening->opens(after);
    write.rows.push_back(RowWrite{&type, after.id, change.typed, std::move(typedAfter), change.revisions, serverNow_});
  }
  if (write.rows.empty()) return std::nullopt;
  return write;
}

std::vector<Governed> ChangeSet::lifecycle() const {
  std::vector<Governed> governed;
  for (const Change& change : changes_) {
    if (change.scope != intentScope_ || !change.type->governsTree || !change.changed()) continue;
    const std::string governedBy = intentScope_.text() + "#" + change.type->name + "#" + change.after.id.column();
    const ScopeKey tree = ScopeKey::tree(change.after.id.column());
    if (change.after.alive() && !change.wasAlive()) governed.push_back(Governed{tree, true, governedBy});
    if (!change.after.alive() && change.wasAlive()) governed.push_back(Governed{tree, false, governedBy});
  }
  return governed;
}

std::vector<ScopeKey> ChangeSet::otherScopes() const {
  std::set<ScopeKey> others;
  for (const Queued& queued : queued_) {
    if (queued.scope != intentScope_) others.insert(queued.scope);
  }
  return {others.begin(), others.end()};
}

void checkGuards(const Intent& intent, const std::map<RecordRef, std::optional<Row>>& stored, const ScopeKey& scope) {
  for (const Guard& guard : intent.guard) {
    const auto row = stored.find(RecordRef{scope, guard.t, guard.id});
    std::optional<Stamp> current;
    if (row != stored.end() && row->second) {
      if (const auto reg = row->second->lattice.f.find(guard.field); reg != row->second->lattice.f.end()) current = reg->second.stamp;
    }
    if (current == guard.stamp) continue;
    const auto writes = std::find_if(intent.d.begin(), intent.d.end(), [&guard](const Delta& delta) { return delta.t == guard.t && delta.id == guard.id; });
    if (current && writes != intent.d.end()) {
      const auto written = writes->lattice.f.find(guard.field);
      if (written != writes->lattice.f.end() && written->second.stamp == *current) continue;
    }
    Json::Value detail(Json::objectValue);
    detail["t"] = guard.t;
    detail["id"] = guard.id.json();
    detail["field"] = guard.field;
    detail["current"] = current ? Json::Value(toString(*current)) : Json::Value(Json::nullValue);
    throw Refusal(code::stale, detail);
  }
}

}
