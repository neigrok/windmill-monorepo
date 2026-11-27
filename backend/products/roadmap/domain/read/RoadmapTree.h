#pragma once

#include "platform/domain/Ids.h"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Roadmap's reads over a roadmap's records as the engine holds them (Roadmap on the sync engine §5, §10): the normalized
// records every read takes, the same in JavaScript (web/src/products/roadmap/domain/records.js) and here, held to one
// rule by packages/api-contract/roadmap/domain/. Ids compare as UTF-8 bytes and stamps in stamp order. Nothing here reads
// storage, time or randomness.

namespace wm::roadmap::read {

// A dated instant in milliseconds, or none when nothing says when.
using Instant = std::optional<std::int64_t>;

struct StepLink {
  std::string url;
  std::string label;
};

// A `node` record: present while alive (D-4). `branch` names the subtree the step owns, `branchStamp` the stamp its
// register was written under (unset when nothing says).
struct Step {
  std::string id;
  bool present = true;
  Hlc born;
  Instant rc;
  Instant ru;
  std::string label;
  std::string icon;
  std::string color = "terracotta";
  std::string ord;
  std::string status = "none";
  std::string description;
  std::vector<StepLink> links;
  std::optional<std::string> branch;
  Hlc branchStamp;
};

struct Kind {
  std::string id;
  bool present = true;
  Hlc born;
  std::string hue;
  std::string label;
  std::string description;
  std::string ord;
};

struct Edge {
  std::string from;
  std::string to;
  bool present = true;
};

// A person's `progress` mark on a step: the time the server received it, the device's, and its stamp.
struct Mark {
  std::string node;
  std::string status = "none";
  bool outOfOrder = false;
  Instant recordedAt;
  Instant deviceAt;
  Hlc stamp;

  // When the person made it: the device's time, else the server's receipt where the mark holds no device time.
  Instant at() const { return deviceAt && *deviceAt > 0 ? deviceAt : recordedAt; }
};

// The owner's `pointer` on a step: the roadmap it opens (D-2), and the stamp it was set under.
struct Pointer {
  std::string node;
  bool present = true;
  std::string opens;
  Hlc setAt;
};

// Where a subtree sits: the roadmap that holds its owning step, and that step.
struct Parent {
  std::string tree;
  std::string step;
  bool operator==(const Parent&) const = default;
};

struct Meta {
  std::string title;
  std::string guide;
  bool guideInherited = false;
  std::string root;  // empty reads as the roadmap's own id
  std::int64_t depth = 0;
  std::string visibility = "private";
  std::string reach = "private";
};

// What a reader holds of one roadmap: `loaded` with its records, or `unread`, known by its place alone.
enum class Read { loaded, unread };

struct TreeRecords {
  std::string id;
  bool present = true;
  Read read = Read::loaded;
  std::optional<Parent> parent;
  std::optional<Meta> meta;  // none while the roadmap's tree scope holds no meta
  std::vector<Step> nodes;
  std::vector<Edge> edges;
  std::vector<Kind> kinds;
  std::vector<Mark> marks;
  std::vector<Pointer> pointers;
};

// One roadmap's records, normalized: steps and kinds in authored order `(ord, born, id)`, links by `(from, to)`, marks
// and pointers by step. Two records of one id are a malformed input and refused. A root whose meta is none, loaded, does
// not stand (D-3): it is a creation or a fork under way.
class RoadmapTree {
public:
  explicit RoadmapTree(TreeRecords records);

  std::string id;
  bool present = true;
  Read read = Read::loaded;
  std::optional<Parent> parent;
  std::optional<Meta> meta;
  std::vector<Step> nodes;
  std::vector<Edge> edges;
  std::vector<Kind> kinds;
  std::map<std::string, Mark> marks;
  std::map<std::string, Pointer> pointers;

  const Step* step(const std::string& id) const;
  const Pointer* pointerOn(const std::string& step) const;
  const Mark* markOn(const std::string& step) const;

private:
  std::map<std::string, std::size_t> slots_;
};

// UTF-8 byte order of two ids, as the domain kit's compareText.
inline bool byteLess(const std::string& a, const std::string& b) { return a < b; }

}
