#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Registry.h"

#include <json/json.h>

#include <compare>
#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace wm::sync {

// D-1: the engine's stamp is the platform HLC, ordered as §3.1 orders stamps.
using Stamp = Hlc;
using Ms = std::uint64_t;

// JSON that does not have the shape §9.1 gives a record's part.
struct WireError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// §9.1: a stamp travels as its D-1 text.
Stamp stampOf(const Json::Value& wire);

// §9.1: a record's id, a string, or an array of ids for a tuple-keyed type. Its JCS is its identity, and
// the records of one type order by the UTF-8 bytes of that JCS.
class RecordId {
public:
  RecordId() = default;
  explicit RecordId(Json::Value value);
  explicit RecordId(const std::string& text) : RecordId(Json::Value(text)) {}

  // §2.2: a table column holds a string id itself, and a tuple as its JCS.
  static RecordId fromColumn(const std::string& column, bool tuple);

  const Json::Value& json() const { return value_; }
  const std::string& key() const { return key_; }
  std::string column() const;

  bool operator==(const RecordId& other) const { return key_ == other.key_; }
  std::strong_ordering operator<=>(const RecordId& other) const { return key_ <=> other.key_; }

private:
  Json::Value value_;
  std::string key_;
};

enum class LifeState { alive, dead };

// D-6: whether a record is alive, and the stamp of the write that said so. Wire: ["alive"|"dead", stamp].
struct Life {
  LifeState state = LifeState::alive;
  Stamp stamp;

  Life(LifeState state, Stamp stamp);
  explicit Life(const Json::Value& wire);

  bool alive() const { return state == LifeState::alive; }
  Json::Value toJson() const;
  bool operator==(const Life&) const = default;
};

// D-9: a lattice register, the value a write set and that write's stamp. Wire: [value, stamp].
struct Reg {
  Json::Value value;
  Stamp stamp;

  Reg(Json::Value value, Stamp stamp);
  explicit Reg(const Json::Value& wire);

  Json::Value toJson() const;
};

// The lattice fields of one record (D-9): its life, its born and its registers by field name, which
// §3.2 joins field by field. Wire: the `life`, `born` and `f` members of a row or a delta, `f` only
// when it holds a register.
struct LatticeRecord {
  std::optional<Life> life;
  std::optional<Stamp> born;
  std::map<std::string, Reg> f;

  LatticeRecord() = default;
  explicit LatticeRecord(const Json::Value& record);

  Json::Value toJson() const;
};

// §9.1 x: a text field's whole text, the seq of the write that set it (0 before any, and on a merge
// step 13 has yet to number), and whether a conflict made it (§6.11).
struct TextVal {
  std::string text;
  Seq rev = 0;
  bool merged = false;

  Json::Value toJson() const;
  bool operator==(const TextVal&) const = default;
};

// §6.11 step 1: the text a write was edited from, named by a head revision or given whole.
struct TextBase {
  std::optional<Seq> rev;
  std::string text;
};

struct TextWrite {
  std::string text;
  TextBase base;
};

// D-6 and §9.1: a record as a page carries it, and as §6.12 hashes it.
struct Row {
  std::string t;
  RecordId id;
  LatticeRecord lattice;
  std::map<std::string, TextVal> x;
  std::map<std::string, Json::Value> v;
  Seq seq = 0;
  Ms rc = 0;
  Ms ru = 0;

  Row() = default;
  Row(std::string t, RecordId id) : t(std::move(t)), id(std::move(id)) {}
  explicit Row(const Json::Value& wire);

  // §6.12: a row is alive while its life is absent or alive.
  bool alive() const { return !lattice.life || lattice.life->alive(); }

  // §9.1: `f`, `x` and `v` only when they hold something.
  Json::Value toJson() const;
  // A dead row as a page carries it: {t, id, life, born?, seq}.
  Json::Value thin() const;
};

// §7.6 visible(r): a singleton always; a record of a type with life while it is alive; otherwise while a
// visibleWhen field (without visibleWhen, any field) holds a value other than null or "".
bool visible(const TypeDef& type, const Row& row);

// D-12: a partial record state. A server-origin delta leaves the stamps of its life, born and registers
// unset (the wire's null), and step 9 mints them (§10.3). Only a command writes serial values.
struct Delta {
  std::string t;
  RecordId id;
  LatticeRecord lattice;
  std::map<std::string, TextWrite> x;
  std::map<std::string, Json::Value> v;

  // Any stamp left for step 9.
  bool unminted() const;
};

}
