#pragma once

#include "platform/domain/Ids.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Identity.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"
#include "platform/domain/sync/Scope.h"
#include "platform/domain/sync/Wire.h"

#include <compare>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

// The pure half of §6.1: what admission decides once the rows it needs are loaded. The application layer
// (platform/application/sync/Admission) locks and loads, calls these in the step order, and persists what
// they answer. Every refusal is thrown as a Refusal.

namespace wm::sync {

// A record by its scope, type and id: how admission addresses what it has locked and loaded.
struct RecordRef {
  ScopeKey scope;
  std::string t;
  RecordId id;

  bool operator==(const RecordRef&) const = default;
  auto operator<=>(const RecordRef&) const = default;
};

// A record as step 5 locked it (§4.2): its id state, the record as the merge sees it (its typed row, or a
// spent id as a thin dead row), and its typed row alone.
struct Locked {
  IdState state;
  std::optional<Row> stored;
  std::optional<Row> typed;

  // §4.2 from what the engine read: this scope's typed row and spent row, whether a typed or spent row of
  // another scope holds a global id, and, for a governing type, the governed scope's governed_by (the outer
  // optional absent when that scope does not exist).
  static Locked compose(const TypeDef& type, const ScopeKey& scope, const RecordId& id, std::optional<Row> typed,
                        std::optional<Row> spent, bool elsewhere, const std::optional<std::optional<std::string>>& governed);
};

// A spent id (§2.1 sync_spent) as the merge sees it: a thin dead row at the seq it died.
Row spentRow(const std::string& t, const RecordId& id, const std::optional<Stamp>& born, const Stamp& lifeStamp, Seq seq);

// Who wrote a delta: a replica's intent, a server origin's intent, a command, or a product check's
// consequence. Only a replica's deltas are held to §4.4's const and time rule, and only theirs keep their
// own stamps (§10.3).
enum class Source { client, server, command, check };

// A superseded text head step 13 keeps (§6.11 step 4).
struct TextRevision {
  std::string field;
  Seq rev = 0;
  std::string text;
};

// One record of the intent after step 9: what a product's check reads and step 13 stores. `stored` and
// `typed` are the record before the intent; `createdBy` holds the source of each of its deltas that creates it,
// in admission order. `joined` is after's lattice as the join wrote it, before G1 dropped a dead record's fields:
// step 10 reads a parent reference there.
struct Change {
  const TypeDef* type = nullptr;
  ScopeKey scope;
  std::vector<Source> createdBy;
  std::optional<Row> stored;
  std::optional<Row> typed;
  bool isNew = false;
  Row after;
  LatticeRecord joined;
  std::vector<TextRevision> revisions;

  // Its lattice fields, texts (without revs) or serial values differ from the record before the intent.
  bool changed() const;
  bool wasAlive() const { return stored && stored->alive(); }
  // `after` as step 13 stores it at `seq`: each newly merged text at rev `seq`, rc kept from the typed row (else
  // serverNow), and ru serverNow.
  Row storedAt(Seq seq, Ms serverNow) const;
};

// A text revision step 9 needs from the product (§6.11 step 1: a {rev} base that is not the head).
struct RevisionWanted {
  RecordRef record;
  std::string field;
  Seq rev = 0;

  auto operator<=>(const RevisionWanted&) const = default;
};

// §6.1 step 11's question for one serial field: the highest value among the alive records of the type
// whose serialNext fields hold `match`.
struct SerialWanted {
  ScopeKey scope;
  const TypeDef* type = nullptr;
  std::string field;
  std::map<std::string, Json::Value> match;

  std::string key() const;
};

// §6.1 step 13 for one record: its typed row before and after (seq, rc and ru set; nullopt deletes it,
// a death under deadRows: spent), and the superseded text heads to keep.
struct RowWrite {
  const TypeDef* type = nullptr;
  RecordId id;
  std::optional<Row> before;
  std::optional<Row> after;
  std::vector<TextRevision> revisions;
  std::optional<Ms> appliedAt;
};

// §6.1 step 13 for one scope: the next seq, counters, digest and open flag, each record's row write, the
// spent ids gained and lost, and the rows the live frame carries (§6.8).
struct ScopeWrite {
  ScopeKey scope;
  Seq seq = 0;
  std::map<std::string, std::int64_t> counters;
  Digest256 digest;
  bool open = false;
  std::vector<RowWrite> rows;
  std::vector<Row> spentAdded;  // thin dead rows
  std::vector<std::pair<std::string, RecordId>> spentRemoved;
  std::vector<Json::Value> frameRows;
};

// What step 15 does to the scope a governing record governs.
struct Governed {
  ScopeKey tree;
  bool created = false;  // otherwise killed
  std::string governedBy;
};

// The records one intent writes, from steps 5–6 through 13.
class ChangeSet {
public:
  ChangeSet(const Registry& registry, ScopeKey intentScope, Ms serverNow, const Limits& limits);

  // Step 6 for one delta step 5 locked: §4.3's decision, then §4.4's const and time rule for a client
  // delta. Queues it for the join unless §4.3 admits it without a change.
  void admit(const TypeDef& type, const ScopeKey& scope, Delta delta, Source source, const Locked& locked);

  // A command's write map (D-20), whose unset stamps the first join pass fills.
  void setWriteMap(std::vector<WriteEntry> write) { write_ = std::move(write); }
  const std::optional<std::vector<WriteEntry>>& writeMap() const { return write_; }

  // §10.3 for one pass of step 9: the queued deltas that still carry unset stamps take one server stamp,
  // after `clock` observes every register they write as stored and as a same-intent client delta writes
  // it; the first pass also stamps the write map. Nothing ticks when nothing is unset.
  void mint(HlcClock& clock);

  // Step 9's text bases the product must load, then the join: every queued delta onto its record in order,
  // the text merges, G1's field drop for a dead non-revivable record, and the record bound on each record the
  // intent changes, measured as step 13 would store it at the next seq of its scope (`scopeSeqs`; a scope this
  // intent creates is at 0) before step 11 gives it a serial.
  std::set<RevisionWanted> revisionsWanted() const;
  void join(const std::map<RevisionWanted, std::optional<std::string>>& revisions, const std::map<std::string, Seq>& scopeSeqs);

  std::vector<Change>& changes() { return changes_; }
  const std::vector<Change>& changes() const { return changes_; }

  // Step 10's parent rule on the joined records, every create and update included, a command's and a check's:
  // the parents step 10 must look up outside the intent, then the rule (a create or update whose parent is not
  // alive, a parent the intent creates counting). The reference is read before G1.
  std::set<RecordRef> parentsWanted() const;
  void checkParents(const std::map<RecordRef, std::optional<Row>>& storedParents) const;

  // Step 11: the stored maxima a new record's serial fields need, then the numbering in admission order.
  std::vector<SerialWanted> serialsWanted() const;
  void assignSerials(const std::map<std::string, std::optional<std::int64_t>>& storedMaxima);

  // Step 12's growth rule per scope, from each scope's stored counters.
  void checkCaps(const std::map<std::string, std::map<std::string, std::int64_t>>& counters);

  // Step 13 for one scope, from its row as stored: nullopt when the intent changed none of its records.
  std::optional<ScopeWrite> stage(const ScopeKey& scope, Seq seq, const std::map<std::string, std::int64_t>& counters,
                                  const Digest256& digest, bool open, const std::optional<Opening>& opening) const;

  // Step 15: the trees the intent's changed governing records create or kill.
  std::vector<Governed> lifecycle() const;

  // Step 14: the scopes a command wrote into other than the intent's, ascending.
  std::vector<ScopeKey> otherScopes() const;

private:
  struct Queued {
    const TypeDef* type = nullptr;
    ScopeKey scope;
    Delta delta;
    Op op = Op::write;
    Source source = Source::client;
    Locked locked;
  };

  const Change* find(const RecordRef& key) const;
  Change* find(const RecordRef& key);

  const Registry& registry_;
  ScopeKey intentScope_;
  Ms serverNow_ = 0;
  Limits limits_;
  std::vector<Queued> queued_;
  std::vector<Change> changes_;
  std::map<RecordRef, std::size_t> positions_;
  std::optional<std::vector<WriteEntry>> write_;
  bool mapStamped_ = false;
  std::map<std::string, std::map<std::string, std::int64_t>> counts_;
};

// Step 7: each guard holds on its stamp, on an unset register guarded by null, or when the register already
// carries the stamp this intent writes to it; else stale {t, id, field, current}.
void checkGuards(const Intent& intent, const std::map<RecordRef, std::optional<Row>>& stored, const ScopeKey& scope);

}
