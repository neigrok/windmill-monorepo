#pragma once

#include "platform/domain/sync/Record.h"

#include <json/json.h>

#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Roadmap's server rules that read nothing (engine.md Appendix A.1): where a roadmap sits among its owner's roadmaps,
// the reach each subtree of a branch takes, and what a new roadmap is born with. RoadmapProduct reads the rows these
// decide over and writes what they decide.

namespace wm::roadmap::engine {

// A subtree sits at most this many roadmaps below its root (Roadmap on the sync engine §13).
inline constexpr std::int64_t kMaxDepth = 8;

// The refusal codes roadmap's registry declares (Appendix A.1, Codes).
inline const std::string kStepOpensATree = "step-opens-a-tree";
inline const std::string kDepthLimit = "depth-limit";
inline const std::string kNotARoot = "not-a-root";
inline const std::string kTurnFinal = "turn-final";

// The kinds a subtree's roadmap is born with, in their order.
struct GenesisKind {
  const char* id;
  const char* hue;
  const char* label;
  const char* description;
  const char* ord;
};
inline constexpr std::array<GenesisKind, 3> kGenesisKinds{{
    {"build", "terracotta", "Build", "Things you make", "a0"},
    {"learn", "olive", "Learn", "Things you figure out", "a1"},
    {"milestone", "gold", "Milestone", "Moments that matter", "a2"},
}};

// A register's value as a row holds it, or null while the register is unset or the row is absent.
Json::Value valueOf(const std::optional<sync::Row>& row, const std::string& field);
// A record of a type with life is present while it is alive; an absent one is not.
bool present(const std::optional<sync::Row>& row);

// A subtree's place: the roadmap that holds the step owning it, as `tree.parent` and `meta.parent` hold it.
struct Place {
  std::string tree;
  std::string step;

  // The place a `parent` register holds, or none for a root's null.
  static std::optional<Place> of(const Json::Value& parent);
  Json::Value toJson() const;
  bool operator==(const Place&) const = default;
};

// The owner's roadmaps as their `tree` records hold them: where a subtree sits, which subtrees a step owns, and what
// lies under a roadmap. Ids compare by their UTF-8 bytes.
class Roadmaps {
public:
  explicit Roadmaps(const std::vector<sync::Row>& rows);

  std::optional<sync::Row> row(const std::string& id) const;
  std::optional<Place> placeOf(const std::string& id) const;
  bool isAlive(const std::string& id) const;
  // Every roadmap the rows hold, alive or not, the least id first.
  std::vector<std::string> ids() const;
  // The alive subtrees `step` of `tree` owns, the least id first.
  std::vector<std::string> ownedBy(const std::string& tree, const std::string& step) const;
  // Every alive subtree under `tree`, each after the roadmap that holds its step.
  std::vector<std::string> under(const std::string& tree) const;
  // The subtrees a step owns and every subtree under them: the branch its presence decides.
  std::vector<std::string> branchOf(const std::string& tree, const std::string& step) const;
  // How many places lead up from `id` to its root, counted no further than one past kMaxDepth.
  std::int64_t depthOf(const std::string& id) const;

private:
  std::map<std::string, sync::Row> rows_;
};

// The reach a subtree takes where it changes.
struct Reach {
  std::string tree;
  std::string reach;
};

// §4 reach over `subtrees`, shallowest first: a subtree takes the reach of the roadmap holding its step while it and
// that step are present, and `private` otherwise. `reachOf` reads a roadmap's reach and `stepPresent` a step's presence,
// both as the caller's intent leaves them.
std::vector<Reach> reaches(const Roadmaps& roadmaps, const std::vector<std::string>& subtrees,
                           const std::function<std::string(const std::string& tree)>& reachOf,
                           const std::function<bool(const Place& step)>& stepPresent);

}
