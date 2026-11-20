#pragma once

#include "products/roadmap/domain/read/FollowGraph.h"
#include "products/roadmap/domain/read/RoadmapTree.h"

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// The roadmaps one reader holds, read together (web/src/products/roadmap/domain/account.js): where each stands (D-3),
// what each step opens and what each roadmap comes to, the dates its completed steps show, and the guides above one.
// A roadmap the reader does not hold stays unknown and one they hold unread stays unread: neither is an empty roadmap.

namespace wm::roadmap::read {

enum class Standing { standing, hidden, unknown };
const char* standingName(Standing);

struct PlaceStep {
  std::string tree;
  std::string step;
  std::optional<std::string> title;
};

// Where a standing roadmap sits: its root, the step that owns it, the way down from the root and how deep.
struct Place {
  std::string root;
  std::optional<Parent> parent;
  std::vector<PlaceStep> path;
  std::int64_t depth = 0;
};

struct Location {
  Standing standing = Standing::unknown;
  std::optional<Place> place;
  std::optional<std::string> title;
};

enum class OpeningKind { subtree, pointer };
enum class OpeningStatus { loaded, unread, unknown, dangling };
const char* openingKindName(OpeningKind);
const char* openingStatusName(OpeningStatus);

// A step's way into another roadmap: the subtree it owns, else the roadmap its pointer opens.
struct Opening {
  std::string node;
  OpeningKind kind = OpeningKind::subtree;
  std::string tree;
  OpeningStatus status = OpeningStatus::unknown;
};

struct Counts {
  std::size_t done = 0;
  std::size_t total = 0;
};

struct DatedStep {
  std::string node;
  Instant at;
};

// A roadmap's completed steps in authored order, and the date each shows.
struct Progress {
  std::vector<std::string> completed;
  std::vector<DatedStep> dates;
};

struct Guide {
  std::string tree;
  std::string title;
  std::string text;
  bool own = false;
};

// The shortest way back up from a roadmap to one that opens it: how many steps up, and the next roadmap down.
struct WayBack {
  std::size_t distance = 0;
  std::optional<std::string> next;
};

struct StaleBranch {
  std::string node;
  std::string tree;
};

class RoadmapAccount {
public:
  explicit RoadmapAccount(std::vector<RoadmapTree> trees);

  const std::map<std::string, RoadmapTree>& trees() const { return trees_; }
  const RoadmapTree* tree(const std::string& id) const;
  Location locationOf(const std::string& id) const;
  const std::vector<Opening>& openingsOf(const std::string& id) const;
  const std::vector<StaleBranch>& staleBranchesOf(const std::string& id) const;
  bool isComplete(const std::string& id) const { return complete_.contains(id); }
  // Groups of standing roadmaps that open one another round, each in id order.
  const std::vector<std::vector<std::string>>& loops() const { return loops_; }
  bool sharesALoop(const std::string& a, const std::string& b) const;

  // A standing loaded roadmap's present steps complete, of all; none otherwise.
  std::optional<Counts> counts(const std::string& id) const;
  std::set<std::string> completedNodes(const std::string& id) const;
  std::optional<Progress> progress(const std::string& id) const;
  // The graph of a standing loaded roadmap, its steps complete as the account reads them.
  std::optional<FollowGraph> graph(const std::string& id) const;
  std::map<std::string, WayBack> waysBack(const std::string& target) const;
  // The nearest eight nonempty guides including the roadmap's own, farthest first.
  std::vector<Guide> guides(const std::string& id) const;

private:
  struct LatestMark {
    Hlc stamp;
    Instant at;
  };
  struct Opener {
    std::string tree;
    std::string node;
  };
  static std::optional<LatestMark> later(const std::optional<LatestMark>& a, const std::optional<LatestMark>& b);
  Location locate(const std::string& id);

  std::map<std::string, RoadmapTree> trees_;
  std::map<std::string, Location> locations_;
  std::map<std::string, std::vector<Opening>> openings_;
  std::map<std::string, std::vector<StaleBranch>> staleBranches_;
  std::map<std::string, std::vector<Opener>> openers_;
  std::map<std::string, std::int64_t> pending_;
  std::set<std::string> complete_;
  std::map<std::string, std::optional<LatestMark>> latestMarks_;
  std::vector<std::vector<std::string>> loops_;
  std::map<std::string, std::size_t> loopOf_;
};

}
