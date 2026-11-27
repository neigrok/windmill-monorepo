#pragma once

#include "products/roadmap/domain/read/FollowGraph.h"
#include "products/roadmap/domain/read/RoadmapAccount.h"

#include <map>
#include <optional>
#include <string>
#include <vector>

// The reads a roadmap answers beside its graph (web/src/products/roadmap/domain/reads.js and diagnostics.js): the legend
// and the hue each kind owns, MCP's search, and the diagnostics of a roadmap and of the pointers out of it.

namespace wm::roadmap::read {

struct HueOwner {
  std::string hue;
  std::string id;
};

struct HueCollision {
  std::string hue;
  std::string owner;
  std::vector<std::string> others;
};

// A hue of the legend a roadmap shows, with the kind that owns it, or none for a hue a step wears that no kind claims, and
// how many present steps wear it.
struct ShownHue {
  std::string hue;
  std::optional<std::string> kind;
  std::size_t steps = 0;
};

// A roadmap's present kinds. Where two wear one hue, the one born first (then the least id) owns it.
class LegendRead {
public:
  explicit LegendRead(const RoadmapTree& tree);

  const std::vector<Kind>& kinds() const { return kinds_; }
  bool claims(const std::string& hue) const { return byHue_.contains(hue); }
  // The kind that owns a hue, or none.
  const Kind* ownerOf(const std::string& hue) const;
  std::vector<HueOwner> owners() const;
  std::vector<HueCollision> collisions() const;
  // The legend a roadmap shows: each hue's owner in the kinds' order, then each hue a present step wears that no kind
  // claims, in the palette's order.
  std::vector<ShownHue> shown() const;
  // The six hues a step may wear: the named kinds of the legend shown in its order, then each hue none of them has, in
  // the palette's order, with no kind.
  std::vector<ShownHue> choices() const;
  // The hue a kind added takes: the first of the palette no entry of the legend has, none once all six are had.
  std::optional<std::string> freeHue() const;
  // The entries of the legend shown that present steps wear, none where they wear fewer than two hues.
  std::vector<ShownHue> filters() const;

private:
  std::vector<Kind> kinds_;
  std::map<std::string, std::vector<Kind>> byHue_;
  std::vector<std::string> worn_;
};

// MCP's search: a `kind` names a present kind, which narrows to its hue beside any `color`; the query is folded to ASCII
// lower case and ranks an exact id, an id prefix, a label, an id and then a description match, authored order within a
// rank. A kind the legend does not hold finds nothing.
struct NodeFilter {
  std::optional<std::string> query;
  std::optional<std::string> color;
  std::optional<std::string> kind;
};
std::vector<std::string> selectNodes(const RoadmapTree& tree, const NodeFilter& filter);

// At most `kListed` entries of a list, and how many were left out.
template <typename Entry>
struct Listed {
  std::vector<Entry> entries;
  std::size_t omitted = 0;
};

// How many steps a finding covers, and the first ten of them.
struct Counted {
  std::size_t count = 0;
  std::vector<std::string> named;
};

struct Smell {
  std::string kind;
  Counted nodes;
};

struct UnclaimedHue {
  std::string hue;
  Counted nodes;
};

// A roadmap's bounded findings: loops among present steps (each by its present members), loops of absent steps alone,
// links naming an id no step record holds, links from a step to itself, the smells, and the hues no kind claims.
struct Diagnostics {
  Listed<Counted> cycles;
  Listed<Counted> absentCycles;
  Listed<std::pair<std::string, std::string>> missingEdges;
  Listed<std::pair<std::string, std::string>> selfEdges;
  std::vector<Smell> smells;
  bool legendEmpty = false;
  std::vector<UnclaimedHue> unclaimedHues;
};
Diagnostics diagnose(const FollowGraph& graph);

struct PathStep {
  std::string tree;
  std::optional<std::string> title;
};

struct TreeLoop {
  std::string node;
  std::vector<PathStep> path;
  std::size_t pathOmitted = 0;
};

struct DanglingPointer {
  std::string node;
  std::string tree;
};

// What a roadmap's openings come to: the loops each closes back to it, the openings that dangle, and the subtrees its
// steps still name that no longer stand where the step is.
struct PointerDiagnostics {
  std::vector<TreeLoop> treeLoops;
  std::size_t treeLoopsOmitted = 0;
  std::vector<DanglingPointer> danglingPointers;
  std::size_t danglingPointersOmitted = 0;
  std::vector<StaleBranch> staleBranches;
  std::size_t staleBranchesOmitted = 0;
};
PointerDiagnostics pointerDiagnostics(const RoadmapAccount& account, const std::string& tree);

}
