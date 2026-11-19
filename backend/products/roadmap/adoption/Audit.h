#pragma once

#include "products/roadmap/adoption/Adoption.h"
#include "products/roadmap/domain/read/RoadmapAccount.h"
#include "products/roadmap/domain/read/RoadmapTree.h"

#include <json/json.h>

#include <map>
#include <optional>
#include <string>
#include <vector>

// The audit of the adoption (Roadmap on the sync engine §8.1): one document a roadmap, written from roadmap's own tables
// before the move and from the engine's records after it, and the parts in which the two differ. A document holds what
// a person and a reader see of the roadmap — its title, guide, place, steps with their fields and life, links, kinds,
// every account's marks with when the server received them, its visibility and who may read it — and never a stamp,
// which the move may lower, or an order key, which it may give: the order is the documents' order of steps and kinds.

namespace wm::roadmap::adoption {

struct DocStep {
  std::string id;
  bool present = true;
  std::string label;
  std::string icon;
  std::string color;
  std::string status;
  std::string description;
  std::vector<read::StepLink> links;
  // The roadmap the owner's pointer on it opens, and the subtree it owns; empty for none.
  std::string opens;
  std::string branch;
};

struct DocLink {
  std::string from;
  std::string to;
  bool present = true;
};

struct DocKind {
  std::string id;
  bool present = true;
  std::string hue;
  std::string label;
  std::string description;
};

struct DocMark {
  std::string account;
  std::string step;
  std::string status;
  bool outOfOrder = false;
  std::int64_t at = 0;
};

// One adopted roadmap. Steps and kinds are in the roadmap's order, links by their ends and marks by account then step.
struct Document {
  std::string id;
  std::string owner;
  std::string title;
  std::string guide;
  bool guideInherited = false;
  std::string forkedFrom;
  std::string root;
  std::optional<read::Parent> parent;
  std::int64_t depth = 0;
  std::string visibility;
  std::string reach;
  bool stands = false;
  std::vector<DocStep> steps;
  std::vector<DocLink> links;
  std::vector<DocKind> kinds;
  std::vector<DocMark> marks;

  Json::Value toJson() const;
};

// The parts of a document the audit compares, each named as the tally names a difference.
inline constexpr const char* kSections[]{"owner", "title", "guide", "place", "visibility", "reach", "standing",
                                         "steps", "stepOrder", "links", "kinds", "kindOrder", "marks"};
// The parts in which `after` differs from `before`, in kSections' order.
std::vector<std::string> differences(const Document& before, const Document& after);

// The old server's reading of every roadmap the survey adopts, by id: each register's value as roadmap's tables hold it
// and as the old server reads it (a colour it does not know as terracotta, active and inProgress as none, a link as its
// lenient reading of it), each record's life by §8.1, and today's order. What the move does not adopt is not in it.
std::map<std::string, Document> documentsBefore(const Survey& survey);

// One roadmap as the engine's tables hold it, read through the binding: its records with its owner's marks and pointers,
// its owner, the copy it was forked from, and the marks of every other account that keeps an overlay of it.
struct EngineRoadmap {
  read::TreeRecords records;
  std::string owner;
  std::string forkedFrom;
  std::map<std::string, std::vector<read::Mark>> otherMarks;
};

// The engine's reading of one owner's roadmaps through the read domain (domain/read), by id: where each stands, and its
// steps, links and kinds in the order the read domain gives them. A dead roadmap has no document.
std::map<std::string, Document> documentsAfter(const std::vector<EngineRoadmap>& roadmaps);

}
