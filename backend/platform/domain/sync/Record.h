#pragma once

#include "platform/domain/Ids.h"

#include <json/json.h>

#include <map>
#include <optional>
#include <stdexcept>
#include <string>

namespace wm::sync {

// D-1: the engine's stamp is the platform HLC, ordered as §3.1 orders stamps.
using Stamp = Hlc;

// JSON that does not have the shape §9.1 gives a record's part.
struct WireError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// §9.1: a stamp travels as its D-1 text.
Stamp stampOf(const Json::Value& wire);

enum class LifeState { alive, dead };

// D-6: whether a record is alive, and the stamp of the write that said so. Wire: ["alive"|"dead", stamp].
struct Life {
  LifeState state = LifeState::alive;
  Stamp stamp;

  Life(LifeState state, Stamp stamp);
  explicit Life(const Json::Value& wire);

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

}
