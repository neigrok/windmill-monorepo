#pragma once

#include "products/roadmap/domain/read/RoadmapTree.h"

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// What a step follows, as it is read (D-5, web/src/products/roadmap/domain/graph.js): its links from present steps and,
// through each absent step it links from, what that step followed; a step's state from those and the marks; what it
// owes and what its completion unlocks. Built over bitsets, so an absent hub between thousands of steps costs no object
// per implied link.

namespace wm::roadmap::read {

// The strongly connected components of a graph given as each vertex's parents, each a list of vertices, emitted every
// component after the components it reaches: a component's parents are settled before it.
struct Components {
  std::vector<std::vector<std::size_t>> groups;
  std::vector<std::size_t> componentOf;
};
Components components(const std::vector<std::vector<std::size_t>>& adjacency);

enum class StepState { complete, available, locked };
const char* stateName(StepState);

// A step this step follows, the links entering it that reach that step, and whether one passes an absent step.
struct Followed {
  std::string id;
  std::vector<std::pair<std::string, std::string>> incoming;
  bool throughAbsent = false;
};

struct StepDetail {
  std::string id;
  std::vector<Followed> followed;
  std::vector<std::string> unmet;
  std::vector<std::string> owed;
  std::vector<std::string> unlocks;
};

// One roadmap's present steps read over its records. `completed` and `dates` are what the account says each step has
// come to; left out, a step is complete by its own mark, unless it owns a subtree or its pointer is present.
class FollowGraph {
public:
  explicit FollowGraph(const RoadmapTree& tree, std::optional<std::set<std::string>> completed = std::nullopt,
                       std::optional<std::map<std::string, Instant>> dates = std::nullopt);

  const RoadmapTree& tree() const { return tree_; }
  // Present step ids in authored order.
  const std::vector<std::string>& ids() const { return ids_; }
  // Every id a present step or a live link names, present steps first.
  const std::vector<std::string>& rawIds() const { return rawIds_; }
  // Each raw vertex's parents, in link order.
  const std::vector<std::vector<std::size_t>>& parents() const { return parents_; }
  const std::vector<Edge>& liveEdges() const { return edges_; }
  bool isPresent(const std::string& id) const { return slot_.count(id) > 0; }
  const std::set<std::string>& completed() const { return completed_; }
  Instant dateOf(const std::string& id) const;

  StepState state(const std::string& id) const;
  // How many present steps this step follows, met or not.
  std::size_t inDegree(const std::string& id) const;
  // The unmet steps it follows: how many, and the first in authored order.
  std::size_t unmetCount(const std::string& id) const;

  std::vector<Followed> followed(const std::string& id) const;
  std::vector<std::string> unmet(const std::string& id) const;
  // Every unfinished step this one waits on, however far up, stopping at completed steps.
  std::vector<std::string> owed(const std::string& id) const;
  std::size_t owedCount(const std::string& id) const;
  // The steps waiting on this one alone.
  const std::vector<std::string>& unlocks(const std::string& id) const;
  StepDetail detail(const std::string& id) const;

private:
  struct Closure {
    std::size_t words = 0;
    std::vector<std::size_t> componentOf;
    std::vector<std::uint32_t> bits;
    std::size_t row(std::size_t vertex) const { return componentOf[vertex] * words; }
  };
  static Closure close(const std::vector<std::vector<std::size_t>>& adjacency,
                       const std::map<std::size_t, std::size_t>& seeds, std::size_t size);
  const Closure& debt() const;

  const RoadmapTree& tree_;
  std::vector<std::string> ids_;
  std::map<std::string, std::size_t> slot_;
  std::vector<Edge> edges_;
  std::vector<std::string> rawIds_;
  std::map<std::string, std::size_t> rawSlot_;
  std::vector<std::vector<std::size_t>> parents_;
  Closure frontier_;
  std::vector<std::uint32_t> direct_;
  std::set<std::string> completed_;
  std::map<std::string, Instant> dates_;
  std::vector<StepState> states_;
  std::vector<std::size_t> unmetCounts_;
  std::vector<std::size_t> inDegrees_;
  std::map<std::string, std::vector<std::string>> unlocked_;
  mutable std::optional<Closure> debt_;
  mutable std::vector<std::string> debtIds_;
};

}
