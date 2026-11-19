#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Scope.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/read/RoadmapTree.h"

#include <json/json.h>

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

// The adoption of production's roadmaps into the sync engine's tables (Roadmap on the sync engine §8.1): roadmap's own
// tables as the move reads them, the rules that turn them into the engine's records, and the plan of every scope it
// writes. Nothing here reads storage or the clock: the time the move started is given.

namespace wm::roadmap::adoption {

// The public demo every database seeds (db/schema.sql), adopted under the house account.
inline const std::string kDemoRoadmap = "t_9e407a96b5330ebe";
// The stamp of every register the move writes where roadmap held none, or none the engine would write: below every
// stamp a device or the server mints, so nothing made later loses to it.
inline const sync::Stamp kLowestServerStamp{0, 0, "srv"};
// A stamp more than this far past the move's start is not one the engine would have stored (engine.md INV-14).
inline constexpr sync::Ms kMaxSkewMs = 300'000;

// Counts by name, the only thing the move prints where anyone may read it: every name is this code's word, never a
// record's. A dot nests a name under another when printed.
class Tally {
public:
  void add(const std::string& name, std::uint64_t count = 1);
  std::uint64_t operator[](const std::string& name) const;
  bool empty() const { return counts_.empty(); }
  Tally& operator+=(const Tally& other);
  Json::Value toJson() const;

private:
  std::map<std::string, std::uint64_t> counts_;
};

// ── What roadmap's own tables hold ──────────────────────────────────────────────────────────────────────────────────

// A register as roadmap's tables keep it: its value, null where the column is, and its stamp's text as stored.
struct OldRegister {
  Json::Value value;
  std::string stamp;

  bool operator==(const OldRegister&) const = default;
};

// A step's row; its links as the old server reads them, each {url, label}.
struct OldStep {
  std::string id;
  std::string added;
  std::string removed;
  OldRegister label;
  OldRegister icon;
  OldRegister color;
  OldRegister ord;
  OldRegister status;
  OldRegister description;
  OldRegister links;
  OldRegister opens;

  bool operator==(const OldStep&) const = default;
};

struct OldLink {
  std::string from;
  std::string to;
  std::string added;
  std::string removed;

  bool operator==(const OldLink&) const = default;
};

struct OldKind {
  std::string id;
  std::string added;
  std::string removed;
  OldRegister hue;
  OldRegister label;
  OldRegister description;
  OldRegister rank;

  bool operator==(const OldKind&) const = default;
};

// One account's mark on one step, as node_progress keeps it, `recordedAt` the time the server received it.
struct OldMark {
  std::string account;
  std::string step;
  std::string status;
  bool outOfOrder = false;
  std::string stamp;
  std::int64_t recordedAt = 0;

  bool operator==(const OldMark&) const = default;
};

// One `trees` row with its rows, times in epoch ms. `head` is the greater of its head_seq and its activity's last seq.
// A roadmap stored only as a whole document comes unfolded into rows, `wholeDocument` saying so.
struct OldRoadmap {
  std::string id;
  std::optional<std::string> owner;
  OldRegister title;
  OldRegister guide;
  bool guideInherited = false;
  std::string visibility = "private";
  std::uint64_t head = 0;
  std::optional<std::string> forkedFrom;
  std::optional<std::int64_t> deletedAt;
  std::int64_t createdAt = 0;
  std::int64_t updatedAt = 0;
  std::optional<read::Parent> parent;
  std::string root;
  std::int64_t depth = 0;
  bool wholeDocument = false;
  // A whole document whose shape the old server could not read either, and how many of its steps and kinds repeat an id
  // one before it holds.
  bool unreadableDocument = false;
  std::uint64_t repeatedDocumentIds = 0;
  // Its share card and video, keyed by its id, and how many lines its activity feed holds: kept as they are.
  bool ogImage = false;
  bool ogVideo = false;
  std::uint64_t activity = 0;
  std::vector<OldStep> steps;
  std::vector<OldLink> links;
  std::vector<OldKind> kinds;
  std::vector<OldMark> marks;

  bool operator==(const OldRoadmap&) const = default;
};

// Every roadmap, the id of every account (users.id as text), and how many rows of each kind name a roadmap no `trees`
// row holds, by kind: `steps`, `links`, `kinds`, `marks`.
struct OldDatabase {
  std::vector<OldRoadmap> roadmaps;
  std::set<std::string> accounts;
  std::map<std::string, std::uint64_t> rowsOfNoRoadmap;
};

// What the move is told: the roadmaps with no owner it adopts under the house account, and when it started.
struct Expectation {
  std::set<std::string> ownerless;
  sync::Ms now = 0;
};

// ── §8.1's rules ────────────────────────────────────────────────────────────────────────────────────────────────────

// A stamp as roadmap holds it: kept where it is one the engine writes, unset ("" or 0:0:), and otherwise malformed, or
// too far in the future to be one, either of which the lowest server stamp takes.
enum class StampState { kept, unset, malformed, future };
struct ReadStamp {
  StampState state = StampState::unset;
  sync::Stamp stamp;

  bool set() const { return state != StampState::unset; }
};
ReadStamp readStamp(const std::string& text, sync::Ms now);
const char* stampStateName(StampState state);

// A step's, a link's or a kind's life, from its add and remove stamps' texts: alive when the add stamp is set and not
// older than the remove stamp, dead when the remove stamp is newer, decided on the stamps as the old server reads them
// (ElementSet::present), a future one included, before either is replaced, and on the replaced stamps where the old server
// cannot parse one. Its life's stamp is the greater of the two as kept or replaced, and it is born at its add stamp, or
// at the lowest server stamp where only the remove stamp is set. None when neither is set.
struct AdoptedLife {
  sync::Life life;
  sync::Stamp born;
};
std::optional<AdoptedLife> lifeOf(const std::string& added, const std::string& removed, sync::Ms now);

// Today's order of a roadmap's steps, `(ord, created, id)` with an empty key first, as order keys: a key that is one is
// kept, and an empty or malformed one becomes a key in the same place among them. Throws sync::OrderKeyError where no
// key fits, which only keys at the very bottom of the space could make so.
struct OrderedStep {
  std::string id;
  std::string ord;
  sync::Stamp created;
};
std::map<std::string, std::string> stepKeys(const std::vector<OrderedStep>& steps);
// A roadmap's kinds in today's order, by rank then id, as order keys a0, a1, …
std::map<std::string, std::string> kindKeys(const std::vector<OldKind>& kinds);

// ── Where each roadmap stands ───────────────────────────────────────────────────────────────────────────────────────

// One roadmap as the move reads it before writing: whose it is, whether it is adopted or its id only spent, where it
// sits and who may read it.
struct Surveyed {
  const OldRoadmap* roadmap = nullptr;
  UserId owner;
  bool deleted = false;
  std::int64_t deletedAt = 0;
  bool stands = false;
  // Its root's visibility, and who may read it: that visibility while it stands, private otherwise.
  std::string visibility = "private";
  std::string reach = "private";
  // The subtree each step owns, by step.
  std::map<std::string, std::string> branches;
  // Whether the old server reads it at all: it refuses a roadmap holding a stamp that is no D-1 stamp anywhere.
  bool readableToday = true;
};

// The database as the move reads it, which it keeps: each roadmap surveyed, what is counted, and what stops the move. A roadmap whose
// place, owner or rows the move cannot read as §8.1 says stops it, and so does one with no owner it was not told to
// expect; nothing is written while anything stops it.
class Survey {
public:
  Survey(OldDatabase database, Expectation expectation);
  Survey(const Survey&) = delete;
  Survey& operator=(const Survey&) = delete;

  const std::map<std::string, Surveyed>& roadmaps() const { return roadmaps_; }
  const Expectation& expectation() const { return expectation_; }
  const std::set<std::string>& accounts() const { return accounts_; }
  const Tally& tally() const { return tally_; }
  const Tally& stops() const { return stops_; }
  bool stopped() const { return !stops_.empty(); }
  // Each stop with the roadmap it came from, for the private record alone.
  const std::vector<std::pair<std::string, std::string>>& stoppedBy() const { return stoppedBy_; }

private:
  void place(const std::string& id);
  void stop(const std::string& roadmap, const std::string& reason);

  OldDatabase database_;
  Expectation expectation_;
  std::set<std::string> accounts_;
  std::map<std::string, const OldRoadmap*> byId_;
  std::map<std::string, Surveyed> roadmaps_;
  Tally tally_;
  Tally stops_;
  std::vector<std::pair<std::string, std::string>> stoppedBy_;
};

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

// One scope the move writes: alive with its rows at their seqs, the scope's seq, counters, digest and open flag, or dead
// since `deadAt` and empty.
struct ScopePlan {
  sync::ScopeKey key;
  UserId owner;
  std::optional<std::string> governedBy;
  std::optional<sync::Ms> deadAt;
  std::vector<sync::Row> rows;
  Seq seq = 0;
  std::map<std::string, std::int64_t> counters;
  sync::Digest256 digest;
  bool open = false;
};

// One roadmap's `tree` record, which its owner's roadmap scope takes at the seq it stands at then, its tree scope and the
// overlays of it: the owner's, with the owner's marks and pointers, and each other account's with their marks.
struct RoadmapPlan {
  std::string id;
  sync::Row record;
  ScopePlan tree;
  std::vector<ScopePlan> overlays;
};

// One owner's roadmaps, and the rows of roadmap's tables the plan of them was made from.
struct OwnerPlan {
  UserId owner;
  std::vector<RoadmapPlan> roadmaps;
  std::vector<OldRoadmap> readFrom;
};

// Every owner's roadmaps as the engine takes them, in owner order, and what the plan counted.
struct Plan {
  std::vector<OwnerPlan> owners;
  Tally tally;
  Tally stops;
  // The stops the plan found itself, each with the roadmap it came from, for the private record alone.
  std::vector<std::pair<std::string, std::string>> stoppedBy;

  bool stopped() const { return !stops.empty(); }
};

// The plan of every roadmap the survey reads, or of those among `only` alone. A plan of a stopped survey is empty. Every
// register it writes is held to its field's domain as admission holds a write (Registry::admitsValue): a value outside it,
// past a bound, or a reference outside its type's id pattern stops the move, counted by type and field.
Plan plan(const Survey& survey, const std::optional<std::set<std::string>>& only = std::nullopt);

}
